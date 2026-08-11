// A call's receiving agent is durable data written by the GHL importer. Keep
// the display fallback here so every dashboard surface handles old records in
// the same way while history is being backfilled.

const bitesitesAgent = name => ({ agentName: name, clientName: 'Bite Sites' });

export function receivingAgent(record = {}) {
  const voice = record.voice && typeof record.voice === 'object' ? record.voice : record;
  const stored = voice.receivingAgent || record.receivingAgent;

  if (stored && typeof stored === 'object') {
    return {
      agentId: String(stored.agentId || stored.id || ''),
      agentName: String(stored.agentName || stored.name || 'Unidentified voice agent'),
      clientName: String(stored.clientName || stored.client || '')
    };
  }

  // Hybrid outbound calls retain the exact saved profile that handled them.
  const profileName = record.agent && typeof record.agent === 'object'
    ? record.agent.profileName
    : '';
  if (profileName) return bitesitesAgent(profileName);

  const legacyAgent = typeof record.agent === 'string' ? record.agent.toLowerCase() : '';
  if (legacyAgent === 'bit') return bitesitesAgent('Bit');

  // Historically every GHL record was stamped `agent: byte`, even when Bella
  // or another client's agent answered. Do not repeat that false attribution.
  if (record.providerCallId || voice.providerCallId) {
    return { agentId: '', agentName: 'Unidentified voice agent', clientName: '' };
  }

  if (legacyAgent === 'byte' || record.source === 'byte_voice') return bitesitesAgent('Byte');
  return { agentId: '', agentName: 'Unidentified voice agent', clientName: '' };
}

export const receivingAgentLabel = record => {
  const receiver = receivingAgent(record);
  return receiver.clientName
    ? `${receiver.agentName} · ${receiver.clientName}`
    : receiver.agentName;
};
