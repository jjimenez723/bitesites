// Firestore reads for the dashboard.
//
// Every collection here is admin-only in firestore.rules, so these queries
// simply fail with permission-denied for anyone else — the UI gate in
// AdminApp is convenience, not the security boundary.
//
// Reads are capped. An analytics collection grows without bound, and a
// dashboard that silently pulls 50k documents is a surprise bill; when a cap is
// hit the UI says so rather than quietly charting a partial window.

import { useEffect, useState, useCallback } from 'react';
import {
  collection, query, where, orderBy, limit, getDocs,
  doc, updateDoc, deleteDoc, setDoc, serverTimestamp
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export const EVENT_CAP = 5000;
export const LIST_CAP = 200;

export const dayKey = date => date.toISOString().slice(0, 10);

export function cutoffDay(days) {
  const date = new Date();
  date.setDate(date.getDate() - (days - 1));
  return dayKey(date);
}

// Firestore timestamps, ISO strings and Dates all turn up depending on whether
// a value came from the server or from a pending local write.
export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const snapshotRows = snapshot => snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));

/** Generic loader with loading/error/refresh, so every view behaves the same. */
export function useQuery(build, deps = []) {
  const [state, setState] = useState({ rows: [], loading: true, error: null, capped: false });

  const run = useCallback(async () => {
    setState(current => ({ ...current, loading: true, error: null }));
    try {
      const { q, cap } = build();
      const snapshot = await getDocs(q);
      const rows = snapshotRows(snapshot);
      setState({ rows, loading: false, error: null, capped: cap ? rows.length >= cap : false });
    } catch (error) {
      console.error('[admin] query failed', error);
      setState({
        rows: [],
        loading: false,
        capped: false,
        error:
          error?.code === 'permission-denied'
            ? 'This account does not have admin access to that data.'
            : error?.message || 'Could not load data.'
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { run(); }, [run]);

  return { ...state, refresh: run };
}

export const useEvents = days =>
  useQuery(() => ({
    cap: EVENT_CAP,
    q: query(
      collection(db, 'events'),
      where('day', '>=', cutoffDay(days)),
      orderBy('day', 'desc'),
      limit(EVENT_CAP)
    )
  }), [days]);

export const useLeads = () =>
  useQuery(() => ({
    cap: LIST_CAP,
    q: query(collection(db, 'leads'), orderBy('createdAt', 'desc'), limit(LIST_CAP))
  }), []);

export const useConversations = (name, orderField) =>
  useQuery(() => ({
    cap: LIST_CAP,
    q: query(collection(db, name), orderBy(orderField, 'desc'), limit(LIST_CAP))
  }), [name, orderField]);

export const useUsers = () =>
  useQuery(() => ({
    cap: LIST_CAP,
    q: query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(LIST_CAP))
  }), []);

/** Loads a conversation's turns on demand — transcripts are only read when opened. */
export async function loadTurns(parent, id, sub) {
  const snapshot = await getDocs(
    query(collection(db, parent, id, sub), orderBy('at', 'asc'), limit(500))
  );
  return snapshotRows(snapshot);
}

export const useRoles = () =>
  useQuery(() => ({ q: query(collection(db, 'roles'), limit(LIST_CAP)) }), []);

export const setLeadStatus = (id, status) => updateDoc(doc(db, 'leads', id), { status });
export const setUserStatus = (id, status) => updateDoc(doc(db, 'users', id), { status });
export const removeLead = id => deleteDoc(doc(db, 'leads', id));

/**
 * Grants a role from the dashboard. Rules let an admin write roles/{uid}, so
 * this works — but it only writes the *document*, not the custom auth claim,
 * because minting a claim needs the Admin SDK. The rules read the claim first
 * and fall back to this document, so access is identical either way; the claim
 * path just saves a read per rule evaluation. `npm run role` sets both.
 */
export const grantRole = (uid, role, email) =>
  setDoc(doc(db, 'roles', uid), { role, email, grantedAt: serverTimestamp() });

export const revokeRole = uid => deleteDoc(doc(db, 'roles', uid));
