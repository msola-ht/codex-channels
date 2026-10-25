/** Hook approval uses literal text. Any visible escape requires review on the host. */
export function canPreserveQqHookReviewText(value: string): boolean {
  return !/[\\<>&\p{Cf}\p{Cc}]/u.test(value.replace(/\n/gu, ""));
}
