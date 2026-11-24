export type ReceiverCallShape = Readonly<{
  nodeType: string;
  calleeField?: string;
  calleeNamedIndex?: number;
  receiverField?: string;
}>;

/** Finite call/reference syntax read once before member-use classification. */
export type MemberUseSyntax = Readonly<{
  callMemberType?: string;
  parentCall?: ReceiverCallShape;
  callReferenceTypes?: Readonly<Record<string, true>>;
  openReferenceTypes?: Readonly<Record<string, true>>;
  openSeparator?: string;
}>;

/** Which bare names need implicit receiver lookup, and how a named miss hides imports. */
export type ImplicitReceiverRules = Readonly<{
  call?: ReceiverCallShape;
  references?: Readonly<Record<string, true>>;
  names?: "all";
  staticContext?: boolean;
  namedMissHidesImports?: boolean;
  staticMissChecksInstance?: boolean;
}>;
