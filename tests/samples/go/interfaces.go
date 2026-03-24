package main

import utilpkg "./utils"

type ValueReader interface {
  GetValue() int
}

func useValueReader(input *utilpkg.UtilityClass) ValueReader {
  return input
}
