<script setup lang="ts">
import { value } from "./logic";
const doubled = value * 2;
</script>

<template>
  <div>{{ doubled }}</div>
</template>
