#include "./utils.h"

typedef struct MyStruct {
  int value;
} MyStruct;

enum Status {
  Ready,
  Done
};

int add(int a, int b) {
  return a + b;
}

#define MAX_VALUE 100
