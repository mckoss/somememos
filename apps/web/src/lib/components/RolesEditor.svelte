<script lang="ts" module>
  export const ROLE_INFO = [
    {
      role: 'memo',
      label: 'Memos',
      hint: 'Lasting notes. Scored, searchable, and what Hot, Trending and Neglected show.',
    },
    {
      role: 'dated',
      label: 'Diary (dated)',
      hint: 'One entry per day; the pattern must hold {YYYY}, {MM} and {DD}.',
    },
    {
      role: 'source',
      label: 'Sources',
      hint: 'Material you keep as-is. Searchable; can’t be edited.',
    },
    {
      role: 'blog',
      label: 'Blog',
      hint: 'Dated posts you can publish. Private until a post says published: true.',
    },
    {
      role: 'excluded',
      label: 'Excluded (private)',
      hint: 'Never imported, indexed, logged or shown. Use it for private folders.',
    },
  ] as const;

  export type RolesText = Record<(typeof ROLE_INFO)[number]['role'], string>;

  /** The editor's text for a role config. */
  export function rolesToText(
    roles: Readonly<Partial<Record<string, readonly string[]>>>,
  ): RolesText {
    const out = {} as RolesText;
    for (const { role } of ROLE_INFO) out[role] = (roles[role] ?? []).join('\n');
    return out;
  }
</script>

<script lang="ts">
  import { roleProblems, rolesFromText } from '#lib/ui/import.ts';

  let {
    value = $bindable(),
    counts,
  }: {
    value: RolesText;
    /** Files per role in the folder being imported, if any. */
    counts?: Readonly<Record<string, number>>;
  } = $props();

  const problems = $derived(roleProblems(rolesFromText(value)));
</script>

<div class="roles">
  <p class="hint">
    One folder or pattern per line. <code>memos/</code> means everything in that folder;
    <code>*</code> matches within a name and <code>**</code> any number of folders. A file takes the first
    role that matches, with Excluded first.
  </p>
  {#each ROLE_INFO as info (info.role)}
    <div class="field role">
      <label for="role-{info.role}">
        {info.label}
        {#if counts}<span class="count">{counts[info.role] ?? 0} files</span>{/if}
      </label>
      <span class="hint" id="role-{info.role}-hint">{info.hint}</span>
      <textarea
        id="role-{info.role}"
        rows="2"
        spellcheck="false"
        autocapitalize="off"
        aria-describedby="role-{info.role}-hint"
        aria-invalid={problems[info.role] ? 'true' : undefined}
        bind:value={value[info.role]}></textarea>
      {#if problems[info.role]}<span class="problem" role="alert">{problems[info.role]}</span>{/if}
    </div>
  {/each}
</div>

<style>
  .roles {
    display: grid;
    gap: var(--space-3);
  }

  .roles > .hint {
    margin: 0;
  }

  .role label {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .count {
    font-weight: 400;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  textarea {
    min-block-size: 2.8rem;
  }

  .problem {
    color: var(--danger);
    font-size: 0.85rem;
  }
</style>
