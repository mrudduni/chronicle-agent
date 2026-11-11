/**
 * The demo history: a few past conversations, placed at dates relative to
 * today so the test questions from the brief line up with them.
 *
 *   - Postgres hosting, on the Tuesday BEFORE last Tuesday. "Last Tuesday"
 *     is ambiguous, so asking about it shows memory settling which Tuesday.
 *   - A CRM shortlist on the most recent Monday ("On Monday we shortlisted...").
 *   - Email marketing tools, a bit over two weeks ago ("What did I ask you on
 *     <date>?").
 *
 * Answers, searches and sources are written out in full, so loading the demo
 * needs no API key and costs nothing. Prices in them are illustrative and
 * frozen at the demo date; re-checking them against today's web is the point.
 */
import type { DateTime } from "luxon";

export interface DemoSource {
  title: string;
  url: string;
  publishedAt: string | null;
  content: string;
}

export interface DemoTurn {
  at: DateTime;
  question: string;
  /** Cites sources as [S1], [S2]... in the order they appear in `searches`. */
  answer: string;
  searches: Array<{ query: string; mode: "page" | "news"; results: DemoSource[] }>;
}

export interface DemoThread {
  turns: DemoTurn[];
}

export interface DemoScript {
  threads: DemoThread[];
  /** Questions to try, worded for today's date. */
  suggestions: string[];
}

/** The most recent given weekday strictly before `now` (1 = Monday ... 7 = Sunday). */
function lastWeekday(now: DateTime, weekday: number) {
  const back = (now.weekday - weekday + 7) % 7 || 7;
  return now.minus({ days: back }).startOf("day");
}

export function buildDemoScript(now: DateTime): DemoScript {
  const crmDay = lastWeekday(now, 1);
  // The Tuesday before last: "last Tuesday" could mean either, and only one has a conversation.
  const pgDay = lastWeekday(now, 2).minus({ weeks: 1 });
  const emailDay = now.startOf("day").minus({ days: 16 });
  const d = (day: DateTime) => day.toFormat("d LLL yyyy");

  const at = (day: DateTime, hour: number, minute = 0) => day.set({ hour, minute });

  const email: DemoThread = {
    turns: [
      {
        at: at(emailDay, 11, 20),
        question: "Which email marketing tool is cheapest for about 5,000 subscribers? Compare Mailchimp, Brevo and MailerLite.",
        answer: `For 5,000 subscribers, **MailerLite** is the cheapest of the three on a monthly plan, **Brevo** is cheapest if you send rarely (it prices by emails sent, not contacts), and **Mailchimp** costs the most.

| Tool | Plan for ~5,000 contacts | Price (as of ${d(emailDay)}) | Pricing model |
|---|---|---|---|
| MailerLite | Growing Business | $39/month [S1] | by subscribers |
| Brevo | Starter, 20k emails/month | $25/month [S2] | by emails sent, contacts unlimited |
| Mailchimp | Standard | $100/month [S3] | by contacts |

If you send one newsletter a week (~20k emails a month), Brevo Starter fits and is cheapest. Sending more often than that, MailerLite's flat price wins. Mailchimp's extra cost buys stronger automation and reporting [S3].`,
        searches: [
          {
            query: "MailerLite pricing 5000 subscribers",
            mode: "page",
            results: [
              {
                title: "Pricing | MailerLite",
                url: "https://www.mailerlite.com/pricing",
                publishedAt: null,
                content: "Growing Business: up to 5,000 subscribers, $39/month billed monthly. Unlimited monthly emails.",
              },
            ],
          },
          {
            query: "Brevo pricing Starter plan",
            mode: "page",
            results: [
              {
                title: "Brevo plans and pricing",
                url: "https://www.brevo.com/pricing/",
                publishedAt: null,
                content: "Starter from $25/month for 20,000 emails per month. Unlimited contacts on all plans.",
              },
            ],
          },
          {
            query: "Mailchimp Standard plan price 5000 contacts",
            mode: "page",
            results: [
              {
                title: "Mailchimp pricing plans",
                url: "https://mailchimp.com/pricing/marketing/",
                publishedAt: null,
                content: "Standard plan for 5,000 contacts: $100/month. Includes advanced automation and predictive segmentation.",
              },
            ],
          },
        ],
      },
    ],
  };

  const postgres: DemoThread = {
    turns: [
      {
        at: at(pgDay, 15, 5),
        question: "Compare Postgres hosting for a small SaaS: Neon, Supabase and AWS RDS. What would it cost us per month?",
        answer: `For a small SaaS (one production database, about 1 GB RAM and 10 GB of data), expect roughly **$0-20/month on Neon**, **$25/month on Supabase** and **about $13/month on AWS RDS** before backups and traffic.

| | Neon | Supabase | AWS RDS (db.t4g.micro) |
|---|---|---|---|
| Entry paid plan | Launch, usage-based, from $5/month [S1] | Pro, $25/month incl. $10 compute credit [S2] | On-demand ~$11.68/month [S3] |
| Storage | $0.35/GB-month [S1] | 8 GB included, then $0.125/GB [S2] | gp3 $0.115/GB-month [S3] |
| Scales to zero | Yes [S1] | No | No |
| Also includes | Branching for dev/staging | Auth, storage, realtime APIs [S2] | Full AWS integration |

*Prices as of ${d(pgDay)}.* Neon is cheapest when traffic is spiky, because compute sleeps when idle. Supabase is the best value if you'd also use its auth and storage. RDS makes sense if the rest of your stack is already on AWS.`,
        searches: [
          {
            query: "Neon serverless Postgres pricing Launch plan",
            mode: "page",
            results: [
              {
                title: "Neon pricing",
                url: "https://neon.com/pricing",
                publishedAt: null,
                content: "Launch: usage-based, from $5/month. Compute $0.14 per CU-hour, storage $0.35 per GB-month. Scale to zero after 5 minutes idle.",
              },
            ],
          },
          {
            query: "Supabase Pro plan pricing compute credits",
            mode: "page",
            results: [
              {
                title: "Pricing & fees | Supabase",
                url: "https://supabase.com/pricing",
                publishedAt: null,
                content: "Pro from $25/month, includes $10 in compute credits (covers a Micro instance) and 8 GB database storage; $0.125 per additional GB.",
              },
            ],
          },
          {
            query: "Amazon RDS PostgreSQL db.t4g.micro on-demand price",
            mode: "page",
            results: [
              {
                title: "Amazon RDS for PostgreSQL Pricing",
                url: "https://aws.amazon.com/rds/postgresql/pricing/",
                publishedAt: null,
                content: "db.t4g.micro Single-AZ, US East (N. Virginia): $0.016 per hour. General Purpose gp3 storage: $0.115 per GB-month.",
              },
            ],
          },
        ],
      },
      {
        at: at(pgDay, 15, 18),
        question: "We'll probably go with Supabase. Anything to watch out for on the Pro plan?",
        answer: `Three things catch small teams out on Supabase Pro:

1. **Compute beyond Micro is extra.** The $10 credit covers one Micro instance; a Small instance adds about $5/month and bigger sizes more [S1].
2. **Egress.** 250 GB/month is included, then $0.09/GB [S1]. Serving files straight from Supabase Storage is where this usually comes from.
3. **Spend cap.** It's on by default and stops overage charges, but also stops your project from exceeding quotas. Turn it off before launch if you'd rather pay than throttle [S1].

*As of ${d(pgDay)}.*`,
        searches: [
          {
            query: "Supabase Pro plan egress compute add-on spend cap",
            mode: "page",
            results: [
              {
                title: "Supabase billing: usage and spend cap",
                url: "https://supabase.com/docs/guides/platform/billing-on-supabase",
                publishedAt: null,
                content: "Pro includes 250 GB egress, then $0.09 per GB. Compute credits of $10 cover one Micro instance. Spend cap is enabled by default.",
              },
            ],
          },
        ],
      },
    ],
  };

  const crm: DemoThread = {
    turns: [
      {
        at: at(crmDay, 10, 30),
        question: "Shortlist 5 CRM tools for a 20-person sales team, with current pricing.",
        answer: `Here's a shortlist of five that fit a 20-seat sales team, cheapest first:

| CRM | Plan that fits | Price per user (as of ${d(crmDay)}) | 20 seats / month | Why it's on the list |
|---|---|---|---|---|
| Freshsales | Growth | $9/user/month, annual [S1] | $180 | Cheapest; built-in phone and email |
| Zoho CRM | Standard | $14/user/month, annual [S2] | $280 | Strong customisation for the price |
| Pipedrive | Advanced | $34/user/month, annual [S3] | $680 | Best pipeline UX for deal-driven teams |
| HubSpot Sales Hub | Professional | $90/user/month, annual [S4] | $1,800 | Best if marketing already uses HubSpot |
| Salesforce | Pro Suite | $100/user/month, annual [S5] | $2,000 | Most extensible; heavier to run |

If you want one recommendation: **Pipedrive** for a pure sales team, **HubSpot** if marketing is in the same tool.`,
        searches: [
          {
            query: "Freshsales pricing Growth plan per user",
            mode: "page",
            results: [
              { title: "Freshsales pricing", url: "https://www.freshworks.com/crm/pricing/", publishedAt: null, content: "Growth: $9/user/month billed annually." },
            ],
          },
          {
            query: "Zoho CRM Standard pricing",
            mode: "page",
            results: [
              { title: "Zoho CRM pricing", url: "https://www.zoho.com/crm/zohocrm-pricing.html", publishedAt: null, content: "Standard: $14/user/month billed annually." },
            ],
          },
          {
            query: "Pipedrive Advanced plan price",
            mode: "page",
            results: [
              { title: "Pipedrive pricing plans", url: "https://www.pipedrive.com/en/pricing", publishedAt: null, content: "Advanced: $34/seat/month billed annually." },
            ],
          },
          {
            query: "HubSpot Sales Hub Professional price per seat",
            mode: "page",
            results: [
              {
                title: "HubSpot Sales Hub pricing",
                url: "https://www.hubspot.com/pricing/sales",
                publishedAt: null,
                content: "Sales Hub Professional: $90/seat/month billed annually. Onboarding fee applies.",
              },
            ],
          },
          {
            query: "Salesforce Pro Suite price per user",
            mode: "page",
            results: [
              {
                title: "Salesforce pricing: small business",
                url: "https://www.salesforce.com/sales/pricing/",
                publishedAt: null,
                content: "Pro Suite: $100/user/month billed annually.",
              },
            ],
          },
        ],
      },
      {
        at: at(crmDay, 10, 44),
        question: "We live in Gmail. Which of those works best with Google Workspace?",
        answer: `**Pipedrive** and **HubSpot** have the deepest Gmail integration of the five; both sync email two ways and add a sidebar inside Gmail [S1] [S2]. Zoho and Freshsales have Gmail extensions too, but they're more limited. Salesforce needs its separate Gmail integration set up by an admin.

Given the earlier shortlist, Pipedrive Advanced ($34/user) is the best value pick for a Gmail-based team [S1].`,
        searches: [
          {
            query: "Pipedrive Gmail integration two-way sync",
            mode: "page",
            results: [
              {
                title: "Pipedrive for Gmail",
                url: "https://www.pipedrive.com/en/features/email-sync",
                publishedAt: null,
                content: "Two-way email sync with Gmail and a Chrome extension that shows deals inside the inbox.",
              },
            ],
          },
          {
            query: "HubSpot Sales Gmail extension",
            mode: "page",
            results: [
              {
                title: "HubSpot Sales Chrome extension for Gmail",
                url: "https://www.hubspot.com/products/sales/gmail-integration",
                publishedAt: null,
                content: "Log emails, track opens and see contact records in a Gmail sidebar.",
              },
            ],
          },
        ],
      },
    ],
  };

  return {
    threads: [email, postgres, crm],
    suggestions: [
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
      `What did I ask you on ${emailDay.toFormat("d LLLL")}? Is your answer still correct today?`,
      "What did we talk about last week?",
    ],
  };
}
