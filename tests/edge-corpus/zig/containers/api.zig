// @def Box @coverage Box partial
pub const Box = struct {
    value: i32, // @def value

    pub fn read(self: *const Box) i32 { // @def read
        return self.value; // @ref value @known-gap struct_field_reference observed=none
    }

    pub fn bump(self: *Box, amount: i32) void { // @def bump
        self.value += amount;
    }

    const Hidden = struct {
        fn secret() i32 { // @def secret
            return 17;
        }
    };
};

// @def Container
pub const Container = struct {
    pub const Nested = struct {
        pub fn answer() i32 { // @def answer
            return 42;
        }
    };
};

pub fn exported() i32 { // @def exported @coverage exported complete @known-gap exported_reference_coverage observed=partial
    return Box.Nested.answer(); // @ref answer @known-gap nested_method_reference observed=none
}

fn internal() i32 { // @def internal
    return Box.Hidden.secret(); // @ref secret @known-gap nested_private_method_reference observed=none
}

pub fn internalUser() i32 { // @def internalUser
    return internal(); // @ref internal @goto internal
}
