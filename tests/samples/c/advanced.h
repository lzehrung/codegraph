#pragma once

#define DEFAULT_COUNT 3

typedef struct AdvancedOptions {
  int count;
} AdvancedOptions;

enum Mode {
  MODE_FAST,
  MODE_SLOW,
};

int run_advanced(AdvancedOptions options);
