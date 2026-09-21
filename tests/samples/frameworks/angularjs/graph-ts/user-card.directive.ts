angular.module("admin").directive("userCard", function userCard(): unknown {
  return {
    scope: {},
    templateUrl: "./user-card.template.html",
    controller: "UserCtrl",
    controllerAs: "vm",
  };
});
