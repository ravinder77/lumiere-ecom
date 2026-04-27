import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, optionalAuth, AuthRequest } from '../middleware/auth';
import type { Order } from '../generated/prisma/client';

const router = Router();

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

function getCustomerEmail(order: Order): string | null {
  const customer = order.customer as { email?: unknown } | null;
  return typeof customer?.email === 'string' ? customer.email.toLowerCase() : null;
}

function canAccessOrder(req: AuthRequest, order: Order, email?: string): boolean {
  if (req.user?.role === 'ADMIN') {
    return true;
  }

  if (req.user?.userId && order.userId === req.user.userId) {
    return true;
  }

  if (!email) {
    return false;
  }

  return getCustomerEmail(order) === email.toLowerCase();
}

// POST /api/orders — direct creation disabled in favor of Stripe checkout flow
router.post('/', async (_req: Request, res: Response) => {
  res.status(400).json({
    success: false,
    error: 'Use POST /api/checkout/session to create a Stripe-backed checkout session.',
  });
});

// GET /api/orders/:id — get single order for the owner, admin, or matching customer email
router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  const order = await prisma.order.findUnique({ where: { id: param(req, 'id') } });
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }

  const rawEmail = req.query['email'];
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : undefined;
  if (!canAccessOrder(req, order, email)) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }

  res.json({ success: true, data: order });
});

// GET /api/orders — get all orders for logged-in user
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: orders });
});

export default router;
