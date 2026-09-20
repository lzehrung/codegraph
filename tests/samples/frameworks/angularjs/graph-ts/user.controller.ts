type UserServiceLike = { load(): void };

interface ControllerScope {
  refresh(): void;
}

angular.module("admin").controller("UserCtrl", [
  "$scope",
  "$state",
  "userService",
  function UserCtrl($scope: ControllerScope, $state: unknown, userService: UserServiceLike) {
    $scope.refresh = function refresh(): void {
      return userService.load();
    };
    void $state;
  },
]);
