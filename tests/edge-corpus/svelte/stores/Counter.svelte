<script lang="ts">
import { createStore, initialCount, scale, type StoreOptions } from "./model.ts";
import Row from "./Row.svelte";
const count = createStore(initialCount); // @def count @ref createStore @goto createStore @ref initialCount @goto initialCount
let doubled = 0; // @def doubled @coverage doubled complete
$: doubled = scale($count); // @ref doubled @goto doubled @ref scale @goto scale
const storeValue = $count; // @ref count @known-gap svelte-store-dollar-reference observed=none
const storeAgain = $count; // @goto count=$count @known-gap svelte-store-dollar-goto observed=not_found
const storeCopy = count; // @ref count @goto count
const doubledCopy = doubled; // @ref doubled @goto doubled
const row = Row; // @def row @coverage row complete
const rowAgain = row; // @ref row @goto row
const config: StoreOptions = { active: true }; // @ref StoreOptions @goto StoreOptions
const initialAgain = initialCount; // @ref initialCount @goto initialCount
const scaled = scale(3); // @ref scale @goto scale
const stringDecoy = "scale"; // @not-ref scale
// @not-ref createStore
/* createStore appears only in this comment decoy. */
// @not-ref-block scale
const sourceSample = `scale($count)
"scale"`;
const componentName = "row"; // @not-ref row
</script>

<main><Row amount={$count} /></main>
