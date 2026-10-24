<script lang="ts">
import { scale } from "./model.ts"; // @ref scale @goto scale
export let amount = 1; // @def amount @coverage amount complete
const rowDoubled = scale(amount); // @def rowDoubled @coverage rowDoubled complete @ref scale @goto scale @ref amount @goto amount
</script>

<li>{rowDoubled}</li>
