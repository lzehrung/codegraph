/**
 * A line of Kotlin after which every declaration of the file is unread. A lone `"` opens a string whose text runs to
 * the next `"`, `\`, or `$`, which is the rest of a file that has none of them, so the file ends in an `ERROR` that
 * holds the text and the declarations in it are not in the tree.
 *
 * A stray `)` or another token does not do that: error recovery resumes at the next declaration and reads it, and only
 * the stray token is an `ERROR`. Use this line wherever a test needs a file whose declarations may be missing from its
 * facts, and write the stray-token case as its own test of the declarations that recovery reads.
 */
export const KOTLIN_UNREAD_TAIL_LINE = '"';
