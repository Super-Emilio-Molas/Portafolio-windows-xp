import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FEEDS = [
  { source: 'Genbeta', url: 'https://www.genbeta.com/feedburner.xml' },
  { source: 'MuyComputer', url: 'https://www.muycomputer.com/feed/' },
  { source: "WWWhat's New", url: 'https://wwwhatsnew.com/feed/' },
  { source: 'Xataka Android', url: 'https://www.xatakandroid.com/feedburner.xml' },
  { source: 'Xataka Móvil', url: 'https://www.xatakamovil.com/feedburner.xml' },
  { source: 'Applesfera', url: 'https://www.applesfera.com/feedburner.xml' },
  { source: 'Hipertextual IA', url: 'https://hipertextual.com/inteligencia-artificial/feed/' },
];

const OUTPUT_PATH = resolve('src/data/news.generated.json');
const MAX_ITEMS = 12;
const MAX_ITEMS_PER_SOURCE = 3;

function textBetween(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLink(entry) {
  const linkTags = entry.match(/<link\b[^>]*>/gi) ?? [];
  const links = linkTags
    .map((tag) => {
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] ?? '';
      return href ? { href: decodeXml(href), rel } : null;
    })
    .filter(Boolean);

  const atomLink =
    links.find((link) => link.rel.toLowerCase() === 'alternate') ??
    links.find((link) => !/replies|comment/i.test(link.rel + link.href));

  if (atomLink) {
    return atomLink.href;
  }

  const rssLink = entry.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return decodeXml((rssLink?.[1] ?? '').trim());
}

function clipText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  const clipped = value.slice(0, maxLength + 1);
  return `${clipped.slice(0, clipped.lastIndexOf(' ')).trim()}...`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('es-PY', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function parseFeed(xml, source) {
  const entries = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) ?? [];

  return entries.map((entry) => {
    const title = textBetween(entry, 'title');
    const url = extractLink(entry);
    const publishedAt =
      textBetween(entry, 'pubDate') ||
      textBetween(entry, 'published') ||
      textBetween(entry, 'updated');
    const summary =
      textBetween(entry, 'description') ||
      textBetween(entry, 'summary') ||
      textBetween(entry, 'content');
    const cleanSummary = /^Article URL:|^Comments URL:|# Comments:/i.test(summary) ? '' : summary;

    return {
      title,
      source,
      url,
      publishedAt: formatDate(publishedAt),
      summary: clipText(cleanSummary, 180),
      timestamp: Date.parse(publishedAt) || 0,
    };
  }).filter((item) => item.title && /^https?:\/\//i.test(item.url));
}

async function fetchFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      'user-agent': 'EmilioXPPortfolio/1.0 (+https://github.com/)',
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    },
  });

  if (!response.ok) {
    throw new Error(`${feed.source}: ${response.status} ${response.statusText}`);
  }

  return parseFeed(await response.text(), feed.source);
}

const results = await Promise.allSettled(FEEDS.map(fetchFeed));
const sourceCounts = new Map();
const items = results
  .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  .sort((a, b) => b.timestamp - a.timestamp)
  .filter((item) => {
    const count = sourceCounts.get(item.source) ?? 0;
    if (count >= MAX_ITEMS_PER_SOURCE) {
      return false;
    }

    sourceCounts.set(item.source, count + 1);
    return true;
  })
  .slice(0, MAX_ITEMS)
  .map(({ timestamp, ...item }) => item);

if (items.length === 0) {
  throw new Error('No se pudieron obtener noticias desde los feeds configurados.');
}

const payload = {
  updatedAt: new Date().toISOString(),
  items,
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(`Noticias actualizadas: ${items.length} items -> ${OUTPUT_PATH}`);
