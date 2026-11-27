<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>{page.status === 404 ? 'Not found' : 'Error'} · somememos</title>
</svelte:head>

<h1 class="page-title">{page.status === 404 ? 'There’s no page here' : 'Something went wrong'}</h1>
<p class="page-intro">{page.error?.message ?? ''}</p>
<a class="button primary" href={resolve('/')}>Go to search</a>
