<template>
  <div class="app">Inline</div>
</template>
<script lang="ts">
import { useLogic } from "./logic";

const state = useLogic();
</script>
<style scoped>
.app {
  color: #444;
}
</style>
