/**
 * A Swift type and an extension of it in an alphabetically earlier file, so a sort by file meets the extension
 * header first. The header spells the type's name but declares nothing: only `Models.swift` declares `Widget`.
 */
export const SWIFT_EXTENSION_OWNER_FILES: Readonly<Record<string, string>> = {
  "Models.swift": "struct Widget {}\n",
  "Extensions.swift": "extension Widget { func added() {} }\n",
};

/** The portable handle of `Widget` in the extension header (1:11 of `Extensions.swift`) that a stale client may hold. */
export const SWIFT_EXTENSION_OWNER_HANDLE = "symbol:Extensions.swift:Widget:1:11";

/** The portable handle of `Widget` where `Models.swift` declares it. */
export const SWIFT_NOMINAL_HANDLE = "symbol:Models.swift:Widget:1:8";
