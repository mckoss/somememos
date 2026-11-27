// Seeds the server under test through its API: a brain with a blog layout,
// published posts, a draft and a private memo, and its blog turned on. All
// content is invented.

import type { FullConfig } from '@playwright/test';
import { E2E_TOKEN } from './playwright.config.ts';

export const BRAIN = 'e2e-blog-brain';
export const SLUG = 'field-notes';

const ROLES = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  blog: ['blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md', 'blog/'],
};

export const LONG_POST = `---
title: Notes from a week of slow bread
published: true
description: What a cold kitchen taught me about patience, flour and timing.
---
# Notes from a week of slow bread

Every loaf this week took two days. The dough rested overnight in a cold
kitchen, and each morning it had become something new. This is a record of
what changed, written for anyone who wants to try it — and a reminder to
myself that [[2026-10-02-the-first-starter|the first attempt]] was a brick.

## The schedule

1. Mix flour and water in the evening, and leave it covered.
2. Add the starter and salt before bed.
3. Shape in the morning; bake when it has risen by half.

Small changes mattered more than I expected. A warmer shelf shortened the
rise by hours; a wetter dough spread unless it was folded twice. The private
list I keep is in [[memos/baking-log]], and it is not public.

> A recipe is a promise about one kitchen. Every other kitchen renegotiates it.

## Timings

| Day | Room °C | Rise (hours) | Result |
|:----|-------:|-------------:|:-------|
| Monday | 17 | 14 | Dense, sour, very good toast |
| Tuesday | 19 | 11 | Open crumb, pale crust |
| Wednesday | 21 | 8 | Best so far: blistered crust and an even crumb throughout the loaf |

## The arithmetic

\`\`\`js
// Baker's percentages: everything relative to the flour.
const flour = 500;
const recipe = { water: 0.72, starter: 0.2, salt: 0.02 };
const grams = Object.fromEntries(Object.entries(recipe).map(([k, v]) => [k, Math.round(v * flour)]));
console.log(grams); // { water: 360, starter: 100, salt: 10 }
\`\`\`

- [x] Buy a thermometer for the shelf
- [ ] Try a darker flour next week

Next time: rye, and a longer cold rest. See also ![[oven-photo.jpg]] and
[an article on fermentation](https://example.com/fermentation).
`;

const NOTES: Record<string, string> = {
  'blog/2026/2026-11-20-notes-from-a-week-of-slow-bread.md': LONG_POST,
  'blog/2026/2026-10-02-the-first-starter.md':
    '---\npublished: true\n---\n# The first starter\n\nIt bubbled once, then sulked for a week. Patience won.\n',
  'blog/2026/2026-09-15-a-kitchen-scale.md':
    '---\npublished: true\ndescription: Why grams beat cups.\n---\n# A kitchen scale\n\nGrams beat cups.\n',
  'blog/2026/2026-11-25-unfinished.md': '# Unfinished draft\n\nNot public.\n',
  'memos/baking-log.md': '# Baking log\n\nPrivate notes.\n',
};

async function api(base: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${E2E_TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL as string;
  await api(base, 'POST', '/api/brains', { id: BRAIN, config: { roles: ROLES } });
  for (const [path, text] of Object.entries(NOTES)) {
    await api(base, 'PUT', `/api/brains/${BRAIN}/notes/${path}`, { text, baseHash: null });
  }
  await api(base, 'PUT', `/api/brains/${BRAIN}/blog`, {
    enabled: true,
    slug: SLUG,
    title: 'Field Notes',
    description: 'Slow experiments in an ordinary kitchen.',
    author: 'Robin Example',
  });
}
