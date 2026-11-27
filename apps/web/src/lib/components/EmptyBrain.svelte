<script lang="ts">
  import { resolve } from '$app/paths';
</script>

<section class="card empty-brain">
  <h2>Your brain is empty</h2>
  <p>
    somememos keeps plain markdown notes on this device and learns what matters to you from how you
    use them: every read, edit and link adds to a note’s activity, and activity fades over a day, a
    week, a month and a year.
  </p>
  <div class="row">
    <a class="button primary" href={resolve('/more')}>Import a folder of notes</a>
    <a class="button" href={resolve('/new')}>Write a note</a>
  </div>
</section>

<style>
  .empty-brain h2 {
    margin-top: 0;
  }

  .empty-brain p {
    color: var(--text-muted);
    max-inline-size: 40rem;
  }
</style>
