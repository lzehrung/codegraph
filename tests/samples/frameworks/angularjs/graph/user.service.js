angular.module("admin").service("userService", function userService($http) {
  this.load = function load() {
    return $http.get("/api/users");
  };
});
