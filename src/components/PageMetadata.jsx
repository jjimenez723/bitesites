import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { metadataForPath, serializeSchema } from '../content/seo.js';

export default function PageMetadata() {
  const { pathname } = useLocation();
  useEffect(() => {
    const meta = metadataForPath(pathname);
    document.title = meta.title;
    const setMeta = (selector, content) => document.head.querySelector(selector)?.setAttribute('content', content);
    setMeta('meta[name="description"]', meta.description);
    setMeta('meta[name="robots"]', meta.noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large');
    setMeta('meta[property="og:title"]', meta.socialTitle || meta.title);
    setMeta('meta[property="og:description"]', meta.socialDescription || meta.description);
    setMeta('meta[property="og:url"]', meta.canonical);
    setMeta('meta[name="twitter:title"]', meta.socialTitle || meta.title);
    setMeta('meta[name="twitter:description"]', meta.socialDescription || meta.description);
    document.head.querySelector('link[rel="canonical"]')?.setAttribute('href', meta.canonical);
    let schema = document.head.querySelector('#site-structured-data');
    if (!meta.schema) schema?.remove();
    else {
      if (!schema) {
        schema = document.createElement('script');
        schema.id = 'site-structured-data';
        schema.type = 'application/ld+json';
        document.head.append(schema);
      }
      schema.textContent = serializeSchema(meta.schema);
    }
  }, [pathname]);
  return null;
}
