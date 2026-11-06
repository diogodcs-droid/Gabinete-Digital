# Security Specification - Giliani Assistente

## Data Invariants
1. A sentence must always be associated with a valid `userId`.
2. Users can only read, write, and delete their own sentences.
3. Timestamps and user IDs must be validated against the request context.

## The Dirty Dozen Payloads (Deny Cases)
1. **Unauthenticated Write**: Creating a sentence without being logged in.
2. **Identity Spoofing**: Creating a sentence with a `userId` that doesn't match the authenticated user.
3. **Cross-User Read**: Attempting to read a sentence belonging to another user.
4. **Cross-User Delete**: Attempting to delete a sentence belonging to another user.
5. **Malicious ID**: Creating a document with an extremely long or invalid character ID.
6. **Shadow Fields**: Adding extra fields (e.g., `isAdmin: true`) not in the schema.
7. **Type Poisoning**: Sending a string for the `metadata` object or a number for `generatedText`.
8. **Size Attack**: Sending a `generatedText` larger than 1MB.
9. **Timestamp Spoofing**: Providing a `createdAt` in the past or future instead of `request.time`.
10. **Global Read Attempt**: Trying to list all sentences without a filter on `userId`.
11. **Update Hijack**: Trying to change the `userId` of an existing document.
12. **Orphaned Write**: (N/A for this simple schema as there are no relations yet).

## Test Runner Logic
The `firestore.rules` will be tested using standard Firebase emulator suites (represented in `firestore.rules.test.ts`).
