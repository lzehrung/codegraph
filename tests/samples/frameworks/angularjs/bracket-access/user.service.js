export function userService($http) {
  return {
    load() {
      return $http.get("/api/users");
    },
  };
}
