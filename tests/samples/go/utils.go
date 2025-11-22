package utils

import "./helpers"

func HelperFunction() string {
  return "Hello from utils"
}

type UtilityClass struct {
  value int
}

func NewUtilityClass(value int) *UtilityClass {
  return &UtilityClass{value: value}
}

func (u *UtilityClass) GetValue() int {
  return u.value
}

func (u *UtilityClass) SetValue(value int) {
  u.value = value
}

const ConstantValue string = "constant"

func ReExportedHelper() string {
  return helpers.HelperFromHelpers()
}