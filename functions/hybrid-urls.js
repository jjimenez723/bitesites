const DEFAULT_PUBLIC_APP_URL = 'https://bitesites.org';

export function hybridOutboundEventsUrl(publicAppUrl = process.env.PUBLIC_APP_URL) {
  const origin = String(publicAppUrl || DEFAULT_PUBLIC_APP_URL).replace(/\/$/, '');
  return `${origin}/api/hybrid-outbound-events`;
}
