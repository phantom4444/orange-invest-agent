// src/agent.ts
import { GoogleGenAI, Type } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { 
  search_providers, 
  get_provider, 
  hold_slot, 
  book, 
  get_booking_status, 
  cancel, 
  reschedule, 
  list_bookings 
} from './tools';
import { ApprovalLedger, BookingProposal } from './approval';

const ai = new GoogleGenAI();

export type AgentState = 
  | 'COLLECTING_DETAILS'
  | 'SEARCHING'
  | 'PROPOSING_OPTIONS'
  | 'WAITING_FOR_APPROVAL'
  | 'WAITING_FOR_RESCHEDULE_SLOT'
  | 'WAITING_FOR_CANCELLATION_APPROVAL'
  | 'WAITING_FOR_RESCHEDULE_APPROVAL'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED';

export interface UserRequirements {
  service?: string;
  area?: string;
  date_range?: string;
  budget?: number;
  preferences?: string[];
}

interface MemoryEntry {
  value: any;
  source: 'stated' | 'inferred';
  confirmed: boolean;
  updated_at: string;
}

interface UserMemoryStore {
  preferences: Record<string, MemoryEntry>;
}

export class AgentOrchestrator {
  private state: AgentState = 'COLLECTING_DETAILS';
  private requirements: UserRequirements = {};
  private approvalLedger = new ApprovalLedger();
  private turnCount = 0;
  private maxTurns = 30;
  private currentProviders: any[] = [];
  private selectedProvider: any = null;
  private selectedSlot: string = '';
  private idempotencyKey: string = '';
  private lastBookingId: string | null = null;
  private reschedulingBookingId: string | null = null;
  private availableRescheduleSlots: string[] = [];

  private pendingCancelBookingId: string | null = null;
  private pendingRescheduleBookingId: string | null = null;
  private pendingRescheduleSlot: string | null = null;

  private memoryFilePath = path.join(process.cwd(), 'user_memory.json');
  private traceFilePath = path.join(process.cwd(), 'agent_trace.jsonl');
  private currentRunTrace: any = {};

  constructor(private userId: string = 'user_default') {
    this.idempotencyKey = `idem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }

  public getState(): AgentState {
    return this.state;
  }

  public getRequirements(): UserRequirements {
    return this.requirements;
  }

  private loadMemoryStore(): UserMemoryStore {
    try {
      if (fs.existsSync(this.memoryFilePath)) {
        return JSON.parse(fs.readFileSync(this.memoryFilePath, 'utf-8'));
      }
    } catch (e) {
      console.error("Error reading memory store:", e);
    }
    return { preferences: {} };
  }

  private saveMemoryStore(store: UserMemoryStore) {
    fs.writeFileSync(this.memoryFilePath, JSON.stringify(store, null, 2));
  }

  public setMemory(key: string, value: any, source: 'stated' | 'inferred', confirmed: boolean = true) {
    const store = this.loadMemoryStore();
    store.preferences[key] = {
      value,
      source,
      confirmed,
      updated_at: new Date().toISOString()
    };
    this.saveMemoryStore(store);
  }

  public forgetMemory(key?: string): string {
    const store = this.loadMemoryStore();
    if (key && store.preferences[key]) {
      delete store.preferences[key];
      this.saveMemoryStore(store);
      return `Forgotten preference: **${key}**. It will never be reused.`;
    } else {
      this.saveMemoryStore({ preferences: {} });
      this.requirements = {};
      return "All persistent user preferences and memory have been forgotten.";
    }
  }

  public viewMemory(): string {
    const store = this.loadMemoryStore();
    const keys = Object.keys(store.preferences);
    if (keys.length === 0) return "No stored user preferences found.";
    
    return "Stored User Memory:\n" + keys.map(k => {
      const entry = store.preferences[k];
      return `- **${k}**: ${entry.value} (Source: *${entry.source}*, Confirmed: ${entry.confirmed})`;
    }).join('\n');
  }

  private initRunTrace(userMessage: string) {
    this.currentRunTrace = {
      timestamp: new Date().toISOString(),
      user_message: userMessage,
      state_before: this.state,
      steps: [],
      model_calls: [],
      tool_calls: [],
      latency_ms: 0
    };
  }

  private logToolCall(toolName: string, args: any, result: any, latency: number) {
    if (this.currentRunTrace.tool_calls) {
      this.currentRunTrace.tool_calls.push({
        tool: toolName,
        arguments: args,
        result: JSON.parse(JSON.stringify(result)),
        latency_ms: latency
      });
    }
  }

  private flushTrace(stateAfter: string, totalLatency: number) {
    try {
      this.currentRunTrace.state_after = stateAfter;
      this.currentRunTrace.latency_ms = totalLatency;
      fs.appendFileSync(this.traceFilePath, JSON.stringify(this.currentRunTrace) + '\n');
    } catch (e) {
      console.error("Error flushing trace:", e);
    }
  }

  public async handleMessage(userMessage: string): Promise<string> {
    const startTime = Date.now();
    this.initRunTrace(userMessage);
    this.turnCount++;

    if (this.turnCount > this.maxTurns) {
      this.state = 'FAILED';
      return "Execution stopped: Reached maximum turn limit (bounded execution cap).";
    }

    const lowerMsg = userMessage.toLowerCase().trim();
    if (['clear', 'reset', 'start over', 'restart'].includes(lowerMsg)) {
      this.requirements = {};
      this.state = 'COLLECTING_DETAILS';
      this.approvalLedger.clear();
      const resMsg = "State and current requirements cleared! What service and city would you like to book?";
      this.flushTrace(this.state, Date.now() - startTime);
      return resMsg;
    }

    // Intercept cancellation approval confirmation
    if (this.state === 'WAITING_FOR_CANCELLATION_APPROVAL' && this.pendingCancelBookingId) {
      const lower = userMessage.toLowerCase();
      if (lower.includes('yes') || lower.includes('confirm') || lower.includes('sure')) {
        const targetId = this.pendingCancelBookingId;
        this.pendingCancelBookingId = null;
        this.state = 'COLLECTING_DETAILS';
        const res = await this.executeConfirmedCancellation(targetId);
        this.flushTrace(this.state, Date.now() - startTime);
        return res;
      } else {
        this.pendingCancelBookingId = null;
        this.state = 'COLLECTING_DETAILS';
        const res = "Cancellation request aborted. How else can I assist you?";
        this.flushTrace(this.state, Date.now() - startTime);
        return res;
      }
    }

    // Intercept reschedule approval confirmation
    if (this.state === 'WAITING_FOR_RESCHEDULE_APPROVAL' && this.pendingRescheduleBookingId && this.pendingRescheduleSlot) {
      const lower = userMessage.toLowerCase();
      if (lower.includes('yes') || lower.includes('confirm') || lower.includes('approve')) {
        const targetId = this.pendingRescheduleBookingId;
        const slotToUse = this.pendingRescheduleSlot;
        this.pendingRescheduleBookingId = null;
        this.pendingRescheduleSlot = null;
        this.state = 'COLLECTING_DETAILS';
        const res = await this.executeConfirmedReschedule(targetId, slotToUse);
        this.flushTrace(this.state, Date.now() - startTime);
        return res;
      } else {
        this.pendingRescheduleBookingId = null;
        this.pendingRescheduleSlot = null;
        this.state = 'COLLECTING_DETAILS';
        const res = "Rescheduling request aborted. How else can I assist you?";
        this.flushTrace(this.state, Date.now() - startTime);
        return res;
      }
    }

    // Intercept slot availability requests during active detail collection
    if (
      lowerMsg.includes('available slot') || 
      lowerMsg.includes('what slot') || 
      lowerMsg.includes('check slot') ||
      lowerMsg.includes('show slot')
    ) {
      if (this.requirements.service && this.requirements.area) {
        const providers = await search_providers(this.requirements.service, this.requirements.area, '');
        if (providers.length > 0) {
          const slotsList = providers.flatMap((p: any) => p.free_slots || []).map((s: string) => `• **${s}**`).join('\n');
          const res = `Available slots for **${this.requirements.service}** in **${this.requirements.area}**:\n${slotsList || 'No free slots listed.'}\n\nWhich slot or time window works best for you?`;
          this.flushTrace(this.state, Date.now() - startTime);
          return res;
        } else {
          const res = `No ${this.requirements.service} providers were found in ${this.requirements.area}. Would you like to try another city?`;
          this.flushTrace(this.state, Date.now() - startTime);
          return res;
        }
      }
    }

    // Intercept when waiting for a reschedule slot choice
    if (this.state === 'WAITING_FOR_RESCHEDULE_SLOT' && this.reschedulingBookingId) {
      const lower = userMessage.toLowerCase();
      const cleanUserMsg = lower.replace(/\s+/g, '');
      
      if (lower.includes('slot') || lower.includes('available') || lower.includes('what') || lower.includes('when')) {
        const slotsFormatted = this.availableRescheduleSlots.length > 0 
          ? this.availableRescheduleSlots.map(s => `• **${s}**`).join('\n')
          : "No alternative slots are currently available for this provider.";
        return `Available slots for rescheduling:\n${slotsFormatted}\n\nWhich slot would you like to choose?`;
      }

      const chosenSlot = this.availableRescheduleSlots.find(slot => {
        const cleanSlot = slot.toLowerCase().replace(/\s+/g, '');
        return cleanUserMsg.includes(cleanSlot) || cleanSlot.includes(cleanUserMsg) || lower.includes(slot.toLowerCase());
      });

      if (chosenSlot || this.availableRescheduleSlots.length === 0) {
        const targetId = this.reschedulingBookingId;
        const slotToUse = chosenSlot || userMessage;
        this.reschedulingBookingId = null;
        this.availableRescheduleSlots = [];

        this.pendingRescheduleBookingId = targetId;
        this.pendingRescheduleSlot = slotToUse;
        this.state = 'WAITING_FOR_RESCHEDULE_APPROVAL';

        const res = `Do you approve rescheduling booking **${targetId}** to **${slotToUse}**? (Reply 'Yes' to confirm)`;
        this.flushTrace(this.state, Date.now() - startTime);
        return res;
      } else {
        const slotsFormatted = this.availableRescheduleSlots.map(s => `• **${s}**`).join('\n');
        return `Please choose one of the available free slots:\n${slotsFormatted}`;
      }
    }

    const parsedIntent = await this.parseIntentWithLLM(userMessage);
    let output = "";

    switch (parsedIntent.primary_intent) {
      case 'CANCEL_BOOKING':
        output = await this.handleCancellation(parsedIntent.extracted_slots?.target_booking_id);
        break;
      case 'RESCHEDULE_BOOKING':
        output = await this.initiateReschedule(parsedIntent.extracted_slots?.target_booking_id);
        break;
      case 'LIST_BOOKINGS':
        output = await this.handleListBookings();
        break;
      case 'VIEW_MEMORY':
        output = this.viewMemory();
        break;
      case 'FORGET_MEMORY':
        output = this.forgetMemory(parsedIntent.extracted_slots?.target_key);
        break;
      case 'GENERAL_QUERY':
        output = parsedIntent.response_draft || "We operate in Jaipur, Jodhpur, Udaipur, Indore, and Bangalore offering plumbing, cleaning, AC servicing, and electrical services.";
        break;
      case 'BOOK_SERVICE':
      default:
        output = await this.handleBookingFlow(parsedIntent, userMessage);
        break;
    }

    this.flushTrace(this.state, Date.now() - startTime);
    return output;
  }

  private async parseIntentWithLLM(userMessage: string) {
    const prompt = `
You are an intent classifier and slot extractor for a home service booking assistant operating in India.
Current Active Requirements: ${JSON.stringify(this.requirements)}
State: ${this.state}

User Message: "${userMessage}"

Rules:
1. If user asks to reschedule ("re-schedule", "reschedule", "change time"), set primary_intent to "RESCHEDULE_BOOKING".
2. If user asks to cancel, set primary_intent to "CANCEL_BOOKING".
3. If user asks where a service is available, set primary_intent to "GENERAL_QUERY".
4. If user asks to view bookings ("show bookings", "my bookings"), set primary_intent to "LIST_BOOKINGS".
5. If user asks about cities or coverage, set primary_intent to "GENERAL_QUERY".
`;

    const modelStartTime = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              primary_intent: {
                type: Type.STRING,
                enum: ['BOOK_SERVICE', 'CANCEL_BOOKING', 'RESCHEDULE_BOOKING', 'LIST_BOOKINGS', 'GENERAL_QUERY', 'VIEW_MEMORY', 'FORGET_MEMORY']
              },
              extracted_slots: {
                type: Type.OBJECT,
                properties: {
                  service: { type: Type.STRING, nullable: true },
                  area: { type: Type.STRING, nullable: true },
                  date_range: { type: Type.STRING, nullable: true },
                  budget: { type: Type.NUMBER, nullable: true },
                  target_booking_id: { type: Type.STRING, nullable: true },
                  new_slot: { type: Type.STRING, nullable: true },
                  target_key: { type: Type.STRING, nullable: true }
                },
                required: ['service', 'area', 'date_range', 'budget', 'target_booking_id', 'new_slot', 'target_key']
              },
              is_confirming_approval: { type: Type.BOOLEAN },
              is_rejecting_approval: { type: Type.BOOLEAN },
              response_draft: { type: Type.STRING, nullable: true }
            },
            required: ['primary_intent', 'extracted_slots', 'is_confirming_approval', 'is_rejecting_approval', 'response_draft']
          }
        }
      });

      this.currentRunTrace.model_calls?.push({
        model: 'gemini-2.5-flash',
        prompt_length: prompt.length,
        latency_ms: Date.now() - modelStartTime
      });

      const parsed = JSON.parse(response.text || '{}');
      this.processExtractedSlots(parsed.extracted_slots, userMessage);
      return parsed;
    } catch (error: any) {
      const lower = userMessage.toLowerCase().trim();
      const cleaned = lower.replace(/[^a-z0-9\s]/g, ' ');
      const slots: any = {};

      if (cleaned.includes('plumb') || cleaned.includes('plub')) slots.service = 'plumbing';
      if (cleaned.includes('electric') || cleaned.includes('wire')) slots.service = 'electrician';
      if (cleaned.includes('ac') || cleaned.includes('cool') || cleaned.includes('servicing')) slots.service = 'ac servicing';
      if (cleaned.includes('clean') || cleaned.includes('dust')) slots.service = 'cleaning';

      if (cleaned.includes('jaip')) slots.area = 'Jaipur';
      if (cleaned.includes('jodh')) slots.area = 'Jodhpur';
      if (cleaned.includes('udai')) slots.area = 'Udaipur';
      if (cleaned.includes('indo')) slots.area = 'Indore';
      if (cleaned.includes('bang') || cleaned.includes('blr')) slots.area = 'Bangalore';

      this.processExtractedSlots(slots, userMessage);

      let intent = 'BOOK_SERVICE';
      let draft: string | null = null;

      if (cleaned.includes('cancel') || cleaned.includes('drop') || lower.includes('upcmong cancel')) {
        intent = 'CANCEL_BOOKING';
      } else if (
        cleaned.includes('resched') || 
        cleaned.includes('re sched') || 
        cleaned.includes('re schedule') ||
        cleaned.includes('move') ||
        cleaned.includes('change time')
      ) {
        intent = 'RESCHEDULE_BOOKING';
      } else if (
        (cleaned.includes('booking') || cleaned.includes('bookings') || cleaned.includes('history')) &&
        !cleaned.includes('resched') && !cleaned.includes('cancel')
      ) {
        intent = 'LIST_BOOKINGS';
      } else if (cleaned.includes('where is') || cleaned.includes('where can i get') || cleaned.includes('which city')) {
        intent = 'GENERAL_QUERY';
        if (cleaned.includes('electric')) draft = "Electrician services are currently available in Jaipur, Jodhpur, Indore, and Bangalore.";
        else if (cleaned.includes('clean')) draft = "Cleaning services are available in Jodhpur, Indore, and Bangalore.";
        else draft = "Our services are available across Jaipur, Jodhpur, Udaipur, Indore, and Bangalore.";
      } else if (cleaned.includes('citi') || cleaned.includes('city') || cleaned.includes('area') || cleaned.includes('cover')) {
        intent = 'GENERAL_QUERY';
        draft = "We cover 5 major cities: Jaipur, Jodhpur, Udaipur, Indore, and Bangalore.";
      }

      return {
        primary_intent: intent,
        extracted_slots: slots,
        is_confirming_approval: cleaned.includes('yes') || cleaned.includes('confirm'),
        is_rejecting_approval: cleaned.includes('no'),
        response_draft: draft
      };
    }
  }

  private processExtractedSlots(slots: any, rawMessage: string) {
    if (slots) {
      if (slots.service) {
        this.requirements.service = slots.service;
        this.setMemory('service', slots.service, 'stated', true);
      }
      if (slots.area) {
        this.requirements.area = slots.area;
        this.setMemory('area', slots.area, 'stated', true);
      }
      if (slots.date_range) {
        this.requirements.date_range = slots.date_range;
        this.setMemory('date_range', slots.date_range, 'stated', true);
      }
    }

    const lower = rawMessage.toLowerCase();
    if (lower.includes('servicing') && !this.requirements.service) {
      this.requirements.service = 'ac servicing';
      this.setMemory('service', 'ac servicing', 'stated', true);
    }

    if (
      lower.includes('morning') || lower.includes('evening') || lower.includes('afternoon') ||
      lower.includes('monday') || lower.includes('tuesday') || lower.includes('wednesday') ||
      lower.includes('thursday') || lower.includes('friday') || lower.includes('saturday') || lower.includes('sunday') ||
      lower.includes('tomorrow') || lower.includes('today') || lower.includes('pm') || lower.includes('am')
    ) {
      this.requirements.date_range = rawMessage.trim();
      this.setMemory('date_range', rawMessage.trim(), 'stated', true);
    }
  }

  private async handleBookingFlow(parsed: any, rawMessage: string): Promise<string> {
    if (this.state === 'WAITING_FOR_APPROVAL') {
      if (parsed.is_confirming_approval) {
        const snapshot = this.approvalLedger.getProposalSnapshot();
        if (!snapshot) {
          this.state = 'COLLECTING_DETAILS';
          return "No active booking proposal found. Let's start over. What service do you need?";
        }

        if (!this.approvalLedger.verifyAndConsumeApproval(snapshot)) {
          this.state = 'COLLECTING_DETAILS';
          return "Approval voided: Booking details changed. Let's re-verify.";
        }

        this.state = 'EXECUTING';
        return await this.executeBooking(snapshot);
      } else if (parsed.is_rejecting_approval || rawMessage.toLowerCase().includes('no')) {
        this.state = 'COLLECTING_DETAILS';
        this.approvalLedger.clear();
        return "Booking proposal cancelled. What would you like to search for or do instead?";
      }
    }

    if (this.state === 'COLLECTING_DETAILS' || this.state === 'SEARCHING') {
      const missingPrompt = this.getMissingRequirements();
      if (missingPrompt) {
        return missingPrompt;
      }

      this.state = 'SEARCHING';
      return await this.executeSearch();
    }

    return `Current state is ${this.state}. How can I assist further?`;
  }

  private async handleCancellation(bookingId?: string | null): Promise<string> {
    const tStartList = Date.now();
    const userBookings = await list_bookings(this.userId);
    this.logToolCall('list_bookings', { user_id: this.userId }, userBookings, Date.now() - tStartList);

    const activeBookings = userBookings.filter((b: any) => b.status === 'upcoming');

    let idToCancel = bookingId || this.lastBookingId;
    if (!idToCancel || !activeBookings.some((b: any) => b.id === idToCancel)) {
      if (activeBookings.length > 0) {
        idToCancel = activeBookings[0].id;
      }
    }

    if (!idToCancel || activeBookings.length === 0) {
      return "I couldn't find any active upcoming bookings to cancel.";
    }

    this.pendingCancelBookingId = idToCancel;
    this.state = 'WAITING_FOR_CANCELLATION_APPROVAL';

    return `Are you sure you want to cancel booking **${idToCancel}**? (Reply 'Yes' to confirm)`;
  }

  private async executeConfirmedCancellation(bookingId: string): Promise<string> {
    let res: any = { status: 'error', code: 503 };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const attemptKey = `cancel_${Date.now()}_${attempt}_${Math.random().toString(36).substring(2, 5)}`;
      const tStart = Date.now();
      res = await cancel(bookingId, attemptKey);
      this.logToolCall('cancel', { booking_id: bookingId, idempotency_key: attemptKey, attempt }, res, Date.now() - tStart);

      if (res.status === 'cancelled') {
        this.state = 'COLLECTING_DETAILS';
        this.lastBookingId = null;
        return `Booking **${bookingId}** has been successfully cancelled.`;
      }
    }

    return `Unable to cancel booking **${bookingId}**. Reason: ${res.message || 'Transient service error.'}`;
  }

  private async initiateReschedule(bookingId?: string | null): Promise<string> {
    const tStart = Date.now();
    const userBookings = await list_bookings(this.userId);
    this.logToolCall('list_bookings', { user_id: this.userId }, userBookings, Date.now() - tStart);

    const activeBookings = userBookings.filter((b: any) => b.status === 'upcoming');

    let targetBooking = null;
    if (bookingId) {
      targetBooking = activeBookings.find((b: any) => b.id === bookingId);
    } else if (this.lastBookingId) {
      targetBooking = activeBookings.find((b: any) => b.id === this.lastBookingId);
    } else if (activeBookings.length > 0) {
      targetBooking = activeBookings[0];
    }

    if (!targetBooking || activeBookings.length === 0) {
      return "I couldn't find any active upcoming bookings to reschedule.";
    }

    this.lastBookingId = targetBooking.id;
    const tStartProv = Date.now();
    const provider = await get_provider(targetBooking.provider_id);
    this.logToolCall('get_provider', { provider_id: targetBooking.provider_id }, provider, Date.now() - tStartProv);

    const slots = provider?.free_slots && provider.free_slots.length > 0 
      ? provider.free_slots 
      : ["Monday 9:00 AM", "Tuesday 2:00 PM", "Wednesday 10:00 AM"];

    this.reschedulingBookingId = targetBooking.id;
    this.availableRescheduleSlots = slots;
    this.state = 'WAITING_FOR_RESCHEDULE_SLOT';

    const slotsList = slots.map((s: string) => `• **${s}**`).join('\n');
    return `Found active booking **${targetBooking.id}** with **${provider?.name || 'Assigned Provider'}**.\n\nAvailable slots:\n${slotsList}\n\nWhich slot would you like to select?`;
  }

  private async executeConfirmedReschedule(bookingId: string, newSlot: string): Promise<string> {
    const tStart = Date.now();
    const resKey = `resched_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const res = await reschedule(bookingId, newSlot, resKey);
    this.logToolCall('reschedule', { booking_id: bookingId, new_slot: newSlot, idempotency_key: resKey }, res, Date.now() - tStart);
    this.availableRescheduleSlots = [];

    if (res.status === 'updated') {
      return `Booking **${bookingId}** has been successfully rescheduled to **${newSlot}**.`;
    }

    return `Rescheduling failed: ${res.message || 'Slot conflict or booking not found'}.`;
  }

  private async handleListBookings(): Promise<string> {
    const tStart = Date.now();
    const bookings = await list_bookings(this.userId);
    this.logToolCall('list_bookings', { user_id: this.userId }, bookings, Date.now() - tStart);

    if (bookings.length === 0) {
      return "You currently have no active or past bookings.";
    }

    const activeBookings = bookings.filter((b: any) => b.status === 'upcoming');
    if (activeBookings.length > 0) {
      this.lastBookingId = activeBookings[0].id;
    }

    const listStr = bookings.map(b => `- **ID:** ${b.id} | Service: ${b.service} | Slot: ${b.slot} | Status: ${b.status}`).join('\n');
    return `Here are your current bookings:\n${listStr}`;
  }

  private getMissingRequirements(): string | null {
    const missing: string[] = [];
    const filled: string[] = [];

    if (this.requirements.service) {
      filled.push(`service: **${this.requirements.service}**`);
    } else {
      missing.push('service type (plumbing, cleaning, ac servicing, or electrician)');
    }

    if (this.requirements.area) {
      filled.push(`city: **${this.requirements.area}**`);
    } else {
      missing.push('city (Jaipur, Jodhpur, Udaipur, Indore, or Bangalore)');
    }

    if (this.requirements.date_range) {
      filled.push(`time/date: **${this.requirements.date_range}**`);
    } else {
      missing.push('time window/date');
    }

    if (missing.length === 0) {
      return null;
    }

    let response = "";
    if (filled.length > 0) {
      response += `I have recorded [${filled.join(', ')}]. `;
    }
    response += `I still need: ${missing.join(', ')}. Could you please provide them?`;
    return response;
  }

  private async executeSearch(): Promise<string> {
    const tStart = Date.now();
    this.currentProviders = await search_providers(
      this.requirements.service || '',
      this.requirements.area || '',
      this.requirements.date_range || ''
    );
    this.logToolCall('search_providers', { service: this.requirements.service, area: this.requirements.area }, this.currentProviders, Date.now() - tStart);

    if (this.currentProviders.length === 0) {
      this.state = 'COLLECTING_DETAILS';
      const failedService = this.requirements.service;
      const failedArea = this.requirements.area;
      
      this.requirements = {};

      return `No ${failedService} providers were found in ${failedArea}. Would you like to check a different city (e.g., Jaipur, Indore, Bangalore) or a different service?`;
    }

    this.selectedProvider = this.currentProviders[0];

    const userRequestedSlot = (this.requirements.date_range || '').toLowerCase();
    const matchedSlot = this.selectedProvider.free_slots?.find((slot: string) => 
      slot.toLowerCase().includes(userRequestedSlot)
    );

    this.selectedSlot = matchedSlot || this.selectedProvider.free_slots[0];

    const proposal: BookingProposal = {
      provider_id: this.selectedProvider.id,
      slot: this.selectedSlot,
      quoted_price: this.selectedProvider.price
    };

    this.approvalLedger.createProposal(proposal);
    this.state = 'WAITING_FOR_APPROVAL';

    return `Found provider: **${this.selectedProvider.name}**\n` +
           `- Service: ${this.requirements.service}\n` +
           `- City: ${this.requirements.area}\n` +
           `- Slot: ${this.selectedSlot}\n` +
           `- Price: ₹${this.selectedProvider.price} (Rating: ${this.selectedProvider.rating}⭐)\n\n` +
           `Do you approve this booking? (Reply 'Yes' to confirm)`;
  }

  private async executeBooking(proposal: BookingProposal): Promise<string> {
    const tStartHold = Date.now();
    const hold = await hold_slot(proposal.provider_id, proposal.slot);
    this.logToolCall('hold_slot', { provider_id: proposal.provider_id, slot: proposal.slot }, hold, Date.now() - tStartHold);

    const tStartBook = Date.now();
    let result = await book(
      hold.hold_id, 
      this.idempotencyKey, 
      this.userId, 
      proposal.provider_id, 
      proposal.slot, 
      hold.quoted_price
    );
    this.logToolCall('book', { hold_id: hold.hold_id, idempotency_key: this.idempotencyKey }, result, Date.now() - tStartBook);

    if (result.status === 'error' && result.code === 'timeout') {
      const tStartStatus = Date.now();
      const statusCheck = await get_booking_status(this.idempotencyKey);
      this.logToolCall('get_booking_status', { idempotency_key: this.idempotencyKey }, statusCheck, Date.now() - tStartStatus);

      if (statusCheck.status === 'booked') {
        this.state = 'COMPLETED';
        this.lastBookingId = statusCheck.booking_id;
        return `Request experienced a gateway timeout, but background verification confirmed your booking is active! Booking ID: **${statusCheck.booking_id}**`;
      } else {
        const tStartRetry = Date.now();
        result = await book(
          hold.hold_id, 
          this.idempotencyKey, 
          this.userId, 
          proposal.provider_id, 
          proposal.slot, 
          hold.quoted_price
        );
        this.logToolCall('book', { retry: true }, result, Date.now() - tStartRetry);
      }
    }

    if (result.status === 'booked') {
      this.state = 'COMPLETED';
      this.lastBookingId = result.booking_id;
      return `Successfully booked! Your booking ID is **${result.booking_id}** with ${this.selectedProvider.name} for ${proposal.slot}.`;
    } else {
      this.state = 'COLLECTING_DETAILS';
      return `Booking failed: ${result.message || 'Slot was taken'}. Let's try another slot or provider.`;
    }
  }
}