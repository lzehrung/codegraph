<script lang="ts">
  import { value } from "./logic";
  let count = value;
  $: doubled = count * 2;
</script>

<div>{doubled}</div>
