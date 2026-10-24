<template>
  <span>{{ cardTitle }}</span>
</template>

<script lang="ts">
import { normalizeLabel } from "./labels.ts"; // @ref normalizeLabel @goto normalizeLabel
export const cardTitle = normalizeLabel("summary"); // @def cardTitle @coverage cardTitle complete @ref normalizeLabel @goto normalizeLabel
const SummaryCard = { name: "SummaryCard" }; // @def SummaryCard @coverage SummaryCard complete
export default SummaryCard; // @ref SummaryCard @goto SummaryCard
</script>
