import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from 'cloudflare:workers';
import { parseHTML } from 'linkedom';

// =====================
// Env bindings
// =====================
interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  MY_WORKFLOW: Workflow;
  NEWS_KV: KVNamespace;
}

// =====================
// Types
// =====================
interface NewsItem {
  id: number;
  title: string;
  url: string;
  score?: number;
  time?: number;
}

interface ProcessedNewsItem extends NewsItem {
  summary: string;
}

interface NewsDayDataValue {
  items: ProcessedNewsItem[];
  lastUpdated: string;
}

interface NewsDayData {
  [date: string]: NewsDayDataValue;
}

interface WorkflowParams {
  date: string; // YYYY-MM-DD
  backfill?: boolean;
}

// =====================
// Helpers
// =====================
function formatDateEST(d: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(d);
}

function getPastDatesEST(count: number): string[] {
  const dates = [];
  const now = new Date();
  const todayStr = formatDateEST(now);
  // Create a UTC date at noon for the current EST date to safely perform date arithmetic
  const current = new Date(`${todayStr}T12:00:00Z`);

  for (let i = 0; i < count; i++) {
    const d = new Date(current);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function fetchNewsContent(url: string) {
  const selectors = [
    "article",
    "[role='main']",
    "main",
    ".post-content",
    ".article-body",
    "#content",
    "#main",
    ".main-content",
    ".entry-content",
    "body" // fallback
  ];

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const { document } = parseHTML(html);

    // 1. Clean up noise
    const noise = document.querySelectorAll('script, style, noscript, iframe, nav, footer, header, .ads, .sidebar');
    noise.forEach((el: any) => el.remove());

    // 2. Cascade matching
    let extractedText = "";

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.textContent?.replace(/\s+/g, ' ').trim();

        // Succeed only when text length > 100
        if (text && text.length > 100) {
          extractedText = text;
          console.log(`Matched by selector: ${selector}`);
          break;
        }
      }
    }

    // 3. Truncate
    return extractedText.substring(0, 500) || "Could not extract meaningful content.";

  } catch (error) {
    console.error(`Fetch error for ${url}:`, error);
    return "";
  }
}

// =====================
// Workflow
// =====================
export class NewsWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const targetDate = event.payload.date || formatDateEST(new Date());

    // 1️⃣ Fetch raw news for the date
    const rawNews = await step.do('fetch-algolia', async (): Promise<NewsItem[]> => {
      // Algolia timestamp range for the target date (UTC)
      const start = new Date(targetDate + 'T00:00:00');
      const end = new Date(targetDate + 'T23:59:59');

      const startTs = Math.floor(new Date(start.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime() / 1000);
      const endTs = Math.floor(new Date(end.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime() / 1000);

      // Query: "tech" related stories
      // We fetch more items (50) to ensure we find 5 good ones after filtering and sorting by score
      const query = `https://hn.algolia.com/api/v1/search?query=tech&tags=story&numericFilters=created_at_i>=${startTs},created_at_i<=${endTs}&hitsPerPage=50`;

      const res = await fetch(query);
      const data: any = await res.json();

      // Map to NewsItem, filter, sort by score, and take top 5
      return data.hits
        .filter((h: any) => h.url) // Must have URL
        .map((h: any) => ({
          id: h.objectID,
          title: h.title,
          url: h.url,
          score: h.points || 0,
          time: h.created_at_i
        }))
        .sort((a: NewsItem, b: NewsItem) => (b.score || 0) - (a.score || 0)) // Sort by score desc
        .slice(0, 5); // Take top 5
    });

    // 2️⃣ Summarize with AI
    const processedNews = await step.do('summarize-news', async (): Promise<ProcessedNewsItem[]> => {
      const tasks = rawNews.map(async (item) => {
        try {
          const content = await fetchNewsContent(item.url);
          const messages = [
            {
              role: 'system',
              content: 'You are a tech news summarizer. Summarize the following news title and content into one concise sentence.'
            },
            {
              role: 'user',
              content: `Title: ${item.title}\nContent: ${content || 'No content available'}`
            }
          ];

          const aiRes: any = await this.env.AI.run(
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any,
            { messages }
          );

          return {
            ...item,
            summary: aiRes.response || 'No summary available'
          };
        } catch (e) {
          console.error(`Processing failed for ${item.id}:`, e);
          return { ...item, summary: 'Summary failed due to error' };
        }
      });
      return await Promise.all(tasks);
    });

    // 3️⃣ Store in KV
    await step.do('save-to-kv', async () => {
      const data: NewsDayDataValue = {
        items: processedNews,
        lastUpdated: new Date().toISOString()
      };
      await this.env.NEWS_KV.put(`news:${targetDate}`, JSON.stringify(data));
    });

    return { status: 'success', date: targetDate, count: processedNews.length };
  }
}

// =====================
// HTTP Entrypoint
// =====================
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // API: Get News
    if (url.pathname === '/api/news') {
      const dates = getPastDatesEST(3); // Today, Yesterday, DayBefore
      const data: NewsDayData = {};
      const missingDates: string[] = [];

      for (const date of dates) {
        const dayData = await env.NEWS_KV.get(`news:${date}`);
        if (dayData) {
          data[date] = JSON.parse(dayData);
        } else {
          missingDates.push(date);
        }
      }

      // Auto-fill (Trigger Backfill) if missing any data
      if (missingDates.length > 0) {
        console.log(`Missing data for ${missingDates.join(', ')}, triggering backfill`);
        for (const date of missingDates) {
          // Fire and forget workflow
          await env.MY_WORKFLOW.create({ params: { date, backfill: true } });
        }
      }

      return Response.json(data);
    }

    // Fallback for API 404
    return new Response('Not Found', { status: 404 });
  },

  // Crons
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Run hourly update for "today"
    const now = new Date(event.scheduledTime);
    const today = formatDateEST(now);

    // Trigger workflow for today's news
    const instance = await env.MY_WORKFLOW.create({ params: { date: today } });
    console.log(`Scheduled workflow started: ${instance.id} for ${today}`);

    // 2. Daily Cleanup
    ctx.waitUntil((async () => {
      const allowedDates = new Set(getPastDatesEST(3)); // [Today, Yesterday, DayBefore]

      const list = await env.NEWS_KV.list({ prefix: 'news:' });

      for (const key of list.keys) {
        // key format: news:YYYY-MM-DD
        const datePart = key.name.split(':')[1];

        // If the date is NOT in our allowed 3 days, delete it.
        if (!allowedDates.has(datePart)) {
          await env.NEWS_KV.delete(key.name);
          console.log(`Deleted old news: ${key.name}`);
        }
      }
    })());
  }
};
