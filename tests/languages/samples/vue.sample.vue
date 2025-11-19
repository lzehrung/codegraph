<template>
  <div class="example">
    <h1>{{ msg }}</h1>
  </div>
</template>

<script>
export default {
  name: 'Example',
  props: {
    msg: String
  }
}
</script>

<style scoped>
.example {
  color: red;
}
</style>

