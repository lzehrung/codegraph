package helpers

import "github.com/sirupsen/logrus"

func HelperFromHelpers() string {
	return "Helper function from helpers module"
}

func AnotherHelper() int {
	return 123
}

func LogHelper() {
	logrus.Info("helper")
}
