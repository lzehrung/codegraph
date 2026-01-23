<script lang="ts">
  import { loadWidget } from "./logic";

  const state = loadWidget();
</script>

<main class="app">{state}</main>

<style>
  .app {
    color: #333;
  }
</style>
