angular.module("admin").service("userService", function userService($http: unknown): void {
  this.load = function load(): unknown {
    return $http;
  };
});
