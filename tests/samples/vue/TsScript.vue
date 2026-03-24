<template>
  <section class="wrapper">
    <Child />
  </section>
</template>
<script lang="ts">
import Child from "./Child.vue";
import { mount } from "./logic.ts";

const currentChild = Child;
mount(currentChild);
</script>
