package consumer;

class ShadowedLocal {
    void hit() {} // @def hitMethod=hit

    void use() {
        int hit = 0;
        hit(); // @ref hitMethod @goto hitMethod=hit
    }
}
