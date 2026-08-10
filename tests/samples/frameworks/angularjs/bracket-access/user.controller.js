import { userService } from "./user.service.js";

angular["module"]("admin").controller("UserCtrl", [
  "$scope",
  "$state",
  "userService",
  function UserCtrl($scope, $state, userService) {
    $scope.refresh = function refresh() {
      return userService.load();
    };
  },
]);
