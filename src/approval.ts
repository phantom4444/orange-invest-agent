// src/approval.ts
import crypto from 'crypto';

export interface BookingProposal {
  provider_id: string;
  slot: string;
  quoted_price: number;
}

export class ApprovalLedger {
  private activeToken: string | null = null;
  private proposalSnapshot: BookingProposal | null = null;

  /**
   * Generates a strict approval token for a proposed booking.
   */
  public createProposal(proposal: BookingProposal): string {
    this.proposalSnapshot = proposal;
    
    // Create a deterministic hash of the exact parameters
    const payload = `${proposal.provider_id}:${proposal.slot}:${proposal.quoted_price}`;
    this.activeToken = crypto.createHash('sha256').update(payload).digest('hex');
    
    return this.activeToken;
  }

  /**
   * Verifies if the user's confirmation matches the exact proposal.
   * Voids immediately if any detail (provider, slot, price) drifted.
   */
  public verifyAndConsumeApproval(currentProposal: BookingProposal): boolean {
    if (!this.activeToken || !this.proposalSnapshot) {
      return false; // No pending approval exists
    }

    // Re-hash the current proposal
    const payload = `${currentProposal.provider_id}:${currentProposal.slot}:${currentProposal.quoted_price}`;
    const currentHash = crypto.createHash('sha256').update(payload).digest('hex');

    // Check if hash matches
    const isValid = currentHash === this.activeToken;

    // Clear the token regardless (one-time use to prevent replay attacks)
    this.clear();

    return isValid;
  }

  public getProposalSnapshot(): BookingProposal | null {
    return this.proposalSnapshot;
  }

  public clear() {
    this.activeToken = null;
    this.proposalSnapshot = null;
  }
}