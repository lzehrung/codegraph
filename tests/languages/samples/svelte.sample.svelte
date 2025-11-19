<script>
  let count = 0;

  function handleClick() {
    count += 1;
  }
</script>

<style>
  button {
    background: #ff3e00;
    color: white;
  }
</style>

<button on:click={handleClick}>
  Clicked {count} {count === 1 ? 'time' : 'times'}
</button>

