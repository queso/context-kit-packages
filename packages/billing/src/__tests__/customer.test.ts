import { describe, expect, mock, test } from "bun:test";
import type { PrismaCustomer } from "../prisma";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID = "user_abc123";
const STRIPE_CUSTOMER_ID = "cus_stripe123";

const EXISTING_CUSTOMER: PrismaCustomer = {
  id: "local_cust_1",
  userId: USER_ID,
  stripeCustomerId: STRIPE_CUSTOMER_ID,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockPrisma(overrides?: {
  customerFindUnique?: ReturnType<typeof mock>;
  customerCreate?: ReturnType<typeof mock>;
// biome-ignore lint/suspicious/noExplicitAny: test mock
}): any {
  return {
    customer: {
      findUnique: overrides?.customerFindUnique ?? mock(() => Promise.resolve(null)),
      create: overrides?.customerCreate ?? mock(() => Promise.resolve(EXISTING_CUSTOMER)),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockStripe(overrides?: {
  customersCreate?: ReturnType<typeof mock>;
// biome-ignore lint/suspicious/noExplicitAny: test mock
}): any {
  return {
    customers: {
      create: overrides?.customersCreate ??
        mock(() => Promise.resolve({ id: STRIPE_CUSTOMER_ID })),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

const { getOrCreateCustomer, getCustomerByUserId, getCustomerByStripeId } =
  await import("../customer");

// ─── getCustomerByUserId ──────────────────────────────────────────────────────

describe("getCustomerByUserId", () => {
  test("returns existing customer when found", async () => {
    const customerFindUnique = mock(() => Promise.resolve(EXISTING_CUSTOMER));
    const prisma = makeMockPrisma({ customerFindUnique });

    const result = await getCustomerByUserId(USER_ID, { prisma });

    expect(result).toEqual(EXISTING_CUSTOMER);
    expect(customerFindUnique).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  test("returns null when no customer found", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: mock(() => Promise.resolve(null)),
    });

    const result = await getCustomerByUserId(USER_ID, { prisma });

    expect(result).toBeNull();
  });
});

// ─── getCustomerByStripeId ────────────────────────────────────────────────────

describe("getCustomerByStripeId", () => {
  test("returns existing customer when found by stripe ID", async () => {
    const customerFindUnique = mock(() => Promise.resolve(EXISTING_CUSTOMER));
    const prisma = makeMockPrisma({ customerFindUnique });

    const result = await getCustomerByStripeId(STRIPE_CUSTOMER_ID, { prisma });

    expect(result).toEqual(EXISTING_CUSTOMER);
    expect(customerFindUnique).toHaveBeenCalledWith({
      where: { stripeCustomerId: STRIPE_CUSTOMER_ID },
    });
  });

  test("returns null when no customer found", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: mock(() => Promise.resolve(null)),
    });

    const result = await getCustomerByStripeId(STRIPE_CUSTOMER_ID, { prisma });

    expect(result).toBeNull();
  });
});

// ─── getOrCreateCustomer ──────────────────────────────────────────────────────

describe("getOrCreateCustomer", () => {
  test("returns existing customer without calling Stripe when record exists", async () => {
    const customersCreate = mock(() => Promise.resolve({ id: STRIPE_CUSTOMER_ID }));
    const prisma = makeMockPrisma({
      customerFindUnique: mock(() => Promise.resolve(EXISTING_CUSTOMER)),
    });
    const stripe = makeMockStripe({ customersCreate });

    const result = await getOrCreateCustomer(USER_ID, { prisma, stripe });

    expect(result).toEqual(EXISTING_CUSTOMER);
    expect(customersCreate).not.toHaveBeenCalled();
  });

  test("creates Stripe customer and local record when none exists", async () => {
    const newCustomer: PrismaCustomer = {
      id: "local_cust_2",
      userId: USER_ID,
      stripeCustomerId: STRIPE_CUSTOMER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const customerFindUnique = mock(() => Promise.resolve(null));
    const customerCreate = mock(() => Promise.resolve(newCustomer));
    const customersCreate = mock(() => Promise.resolve({ id: STRIPE_CUSTOMER_ID }));

    const prisma = makeMockPrisma({ customerFindUnique, customerCreate });
    const stripe = makeMockStripe({ customersCreate });

    const result = await getOrCreateCustomer(USER_ID, { prisma, stripe });

    expect(result).toEqual(newCustomer);
    expect(customersCreate).toHaveBeenCalledWith({
      metadata: { userId: USER_ID },
    });
    expect(customerCreate).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        stripeCustomerId: STRIPE_CUSTOMER_ID,
      },
    });
  });

  test("passes userId in Stripe customer metadata", async () => {
    const customersCreate = mock(() => Promise.resolve({ id: "cus_new" }));
    const customerCreate = mock(() =>
      Promise.resolve({ ...EXISTING_CUSTOMER, stripeCustomerId: "cus_new" })
    );

    const prisma = makeMockPrisma({
      customerFindUnique: mock(() => Promise.resolve(null)),
      customerCreate,
    });
    const stripe = makeMockStripe({ customersCreate });

    await getOrCreateCustomer(USER_ID, { prisma, stripe });

    expect(customersCreate).toHaveBeenCalledWith({
      metadata: { userId: USER_ID },
    });
  });

  test("propagates Stripe API errors from stripe.customers.create", async () => {
    const stripeApiError = new Error("Stripe API unavailable");

    const prisma = makeMockPrisma({
      customerFindUnique: mock(() => Promise.resolve(null)),
    });
    const stripe = makeMockStripe({
      customersCreate: mock(() => Promise.reject(stripeApiError)),
    });

    await expect(getOrCreateCustomer(USER_ID, { prisma, stripe })).rejects.toThrow(
      "Stripe API unavailable"
    );
  });

  test("handles P2002 race condition: returns record created by concurrent request", async () => {
    // First findUnique returns null, customer.create throws P2002 (race),
    // recovery findUnique returns the record created by the concurrent request.
    const concurrentCustomer: PrismaCustomer = {
      id: "local_cust_concurrent",
      userId: USER_ID,
      stripeCustomerId: "cus_concurrent_stripe",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const uniqueConstraintError = new Error("Unique constraint failed on the fields: (`userId`)");
    (uniqueConstraintError as { code?: string }).code = "P2002";

    let findUniqueCallCount = 0;
    const customerFindUnique = mock(() => {
      findUniqueCallCount += 1;
      if (findUniqueCallCount === 1) return Promise.resolve(null);
      return Promise.resolve(concurrentCustomer);
    });

    const customerCreate = mock(() => Promise.reject(uniqueConstraintError));
    const customersCreate = mock(() =>
      Promise.resolve({ id: "cus_newly_created_but_unused" })
    );

    const prisma = makeMockPrisma({ customerFindUnique, customerCreate });
    const stripe = makeMockStripe({ customersCreate });

    const result = await getOrCreateCustomer(USER_ID, { prisma, stripe });

    expect(result).toEqual(concurrentCustomer);
    // Stripe was called once before the race condition was discovered
    expect(customersCreate).toHaveBeenCalledTimes(1);
    // findUnique called twice: initial lookup + recovery fetch
    expect(customerFindUnique).toHaveBeenCalledTimes(2);
  });

  test("re-throws P2002 error when recovery findUnique returns null (orphaned Stripe customer)", async () => {
    // P2002 race condition, but the recovery fetch also finds nothing.
    // This is an unexpected state (orphaned Stripe customer created before the
    // DB write). The implementation should surface the original error so the
    // caller knows something went wrong rather than silently returning undefined.
    const uniqueConstraintError = new Error("Unique constraint failed on the fields: (`userId`)");
    (uniqueConstraintError as { code?: string }).code = "P2002";

    const customerFindUnique = mock(() => Promise.resolve(null));
    const customerCreate = mock(() => Promise.reject(uniqueConstraintError));

    const prisma = makeMockPrisma({ customerFindUnique, customerCreate });
    const stripe = makeMockStripe();

    await expect(getOrCreateCustomer(USER_ID, { prisma, stripe })).rejects.toThrow(
      "Failed to create customer for user"
    );
    // findUnique called twice: initial lookup + recovery fetch (both null)
    expect(customerFindUnique).toHaveBeenCalledTimes(2);
  });

  test("re-throws non-unique-constraint errors from customer.create", async () => {
    const unexpectedError = new Error("Database connection lost");

    const prisma = makeMockPrisma({
      customerFindUnique: mock(() => Promise.resolve(null)),
      customerCreate: mock(() => Promise.reject(unexpectedError)),
    });
    const stripe = makeMockStripe();

    await expect(getOrCreateCustomer(USER_ID, { prisma, stripe })).rejects.toThrow(
      "Database connection lost"
    );
  });
});
