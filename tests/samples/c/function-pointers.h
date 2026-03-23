#pragma once

typedef int (*Comparator)(int left, int right);

enum AdvancedState {
  STATE_READY,
  STATE_DONE,
};

int compare_values(int left, int right);
