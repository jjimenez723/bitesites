// Firestore-backed operating ledger for the Finance tab.
//
// The fixed starter ids make initialization idempotent, including React dev
// double-mounts. Firestore rules remain the authority: admins can read these
// collections, while only the finance owner can write them.

import { useCallback, useEffect, useState } from 'react';
import {
  collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, writeBatch
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import {
  STARTER_ACCOUNTS, STARTER_EXPENSES, STARTER_INCOME, STARTER_LEDGER, STARTER_TEAM
} from './finance-seed';

export { FINANCE_OWNER_EMAILS } from './finance-seed';

const paths = {
  team: 'financeTeam',
  accounts: 'financeAccounts',
  expenses: 'financeExpenses',
  income: 'financeIncome'
};

const rows = snapshot => snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));

async function loadLedger() {
  const [settings, team, accounts, expenses, income] = await Promise.all([
    getDoc(doc(db, 'financeSettings', 'ledger')),
    getDocs(collection(db, paths.team)),
    getDocs(collection(db, paths.accounts)),
    getDocs(collection(db, paths.expenses)),
    getDocs(collection(db, paths.income))
  ]);
  return {
    initialized: settings.exists(),
    team: rows(team),
    accounts: rows(accounts),
    expenses: rows(expenses),
    income: rows(income)
  };
}

export async function initializeFinanceLedger() {
  const batch = writeBatch(db);
  const writeRows = (key, entries) => {
    entries.forEach(({ id, ...entry }) => {
      batch.set(doc(db, paths[key], id), {
        ...entry, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    });
  };
  writeRows('team', STARTER_TEAM);
  writeRows('accounts', STARTER_ACCOUNTS);
  writeRows('expenses', STARTER_EXPENSES);
  writeRows('income', STARTER_INCOME);
  batch.set(doc(db, 'financeSettings', 'ledger'), {
    version: 1,
    initializedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await batch.commit();
}

export function useFinanceLedger(canWrite) {
  const [state, setState] = useState({
    ...STARTER_LEDGER, loading: true, error: '', usingStarterData: false
  });

  const refresh = useCallback(async () => {
    setState(current => ({ ...current, loading: true, error: '' }));
    try {
      let ledger = await loadLedger();
      if (!ledger.initialized && canWrite) {
        await initializeFinanceLedger();
        ledger = await loadLedger();
      }
      if (!ledger.initialized) {
        setState({ ...STARTER_LEDGER, loading: false, error: '', usingStarterData: true });
      } else {
        setState({ ...ledger, loading: false, error: '', usingStarterData: false });
      }
    } catch (error) {
      console.error('[finance] could not load the ledger', error);
      setState(current => ({
        ...current,
        loading: false,
        error: error?.code === 'permission-denied'
          ? 'This account does not have access to the finance ledger.'
          : error?.message || 'Could not load the finance ledger.'
      }));
    }
  }, [canWrite]);

  useEffect(() => { refresh(); }, [refresh]);
  return { ...state, refresh };
}

async function saveRow(path, value) {
  const { id, createdAt, updatedAt, ...data } = value;
  const reference = id ? doc(db, path, id) : doc(collection(db, path));
  await setDoc(reference, {
    ...data,
    ...(id ? {} : { createdAt: serverTimestamp() }),
    updatedAt: serverTimestamp()
  }, { merge: Boolean(id) });
  return reference.id;
}

export const saveFinanceAccount = account => saveRow(paths.accounts, account);
export const saveFinanceExpense = expense => saveRow(paths.expenses, expense);
export const saveFinanceIncome = income => saveRow(paths.income, income);
export const saveFinanceTeamMember = member => saveRow(paths.team, member);

export const deleteFinanceAccount = id => deleteDoc(doc(db, paths.accounts, id));
export const deleteFinanceExpense = id => deleteDoc(doc(db, paths.expenses, id));
export const deleteFinanceIncome = id => deleteDoc(doc(db, paths.income, id));
export const deleteFinanceTeamMember = id => deleteDoc(doc(db, paths.team, id));
