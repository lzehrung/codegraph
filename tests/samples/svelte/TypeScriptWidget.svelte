<script lang="ts">
  import Widget from "./Widget.svelte";
  import { mount } from "./logic.ts";

  const currentWidget = Widget;
  mount(currentWidget);
</script>

<Widget />
