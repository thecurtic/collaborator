/** A pending branch the next message (typed or spoken) should fork from. */
export interface BranchTarget {
  turnId: number;
  paragraphIndex?: number;
  label: string;
}
