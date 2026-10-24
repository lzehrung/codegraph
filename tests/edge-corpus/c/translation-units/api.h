#ifndef EDGE_API_H
#define EDGE_API_H

typedef struct Record {
    int count; // @def count
    char label[8]; // @def label
} Record; // @def Record

typedef union Payload {
    int number; // @def number
    void *pointer; // @def pointer
} Payload; // @def Payload

enum Status {
    STATUS_READY, // @def STATUS_READY
    STATUS_DONE // @def STATUS_DONE
};

typedef int (*Comparator)(int left, int right); // @def Comparator

extern int public_value(int input); // @def public_value @coverage public_value complete
int shared_name(int input); // @def shared_name

#define DECOY_MACRO(x) public_value(x) /* @not-ref public_value */
#define STATUS_ALIAS STATUS_READY /* @not-ref STATUS_READY */
#define DECOY_DONE STATUS_DONE /* @not-ref STATUS_DONE */

#endif
