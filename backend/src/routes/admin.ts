import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';
import { products } from '../data/products';

const router = Router();
router.use(authenticate, requireAdmin);

// GET /api/admin/stats
router.get('/stats', async (_req: Request, res: Response) => {
  const [userCount, orderCount, orders] = await Promise.all([
    prisma.user.count(),
    prisma.order.count(),
    prisma.order.findMany({ select: { total: true, status: true, createdAt: true } }),
  ]);

  const revenue = orders.reduce((s: number, o: { total: number }) => s + o.total, 0);
  const pendingOrders   = orders.filter((o: { status: string }) => o.status === 'PENDING').length;
  const processingOrders = orders.filter((o: { status: string }) => o.status === 'PROCESSING').length;

  // Revenue last 7 days
  const now = new Date();
  const revenueByDay = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(now);
    date.setDate(date.getDate() - (6 - i));
    const dateStr = date.toISOString().split('T')[0];
    const dayRevenue = orders
      .filter((o: { createdAt: Date; total: number }) => o.createdAt.toISOString().split('T')[0] === dateStr)
      .reduce((s: number, o: { total: number }) => s + o.total, 0);
    return { date: dateStr, revenue: Math.round(dayRevenue * 100) / 100 };
  });

  res.json({
    success: true,
    data: {
      users: { total: userCount },
      orders: { total: orderCount, pending: pendingOrders, processing: processingOrders },
      revenue: { total: Math.round(revenue * 100) / 100, byDay: revenueByDay },
      products: { total: products.length, inStock: products.filter((p) => p.stock > 0).length },
    },
  });
});

// GET /api/admin/users
router.get('/users', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  res.json({ success: true, data: users });
});

// PATCH /api/admin/users/:id/role
router.patch('/users/:id/role', async (req: Request, res: Response) => {
  const { role } = req.body as { role: 'CUSTOMER' | 'ADMIN' };
  if (!['CUSTOMER', 'ADMIN'].includes(role)) {
    res.status(400).json({ success: false, error: 'Invalid role' });
    return;
  }
  const user = await prisma.user.update({
    where: { id: req.params['id'] as string },
    data: { role },
    select: { id: true, email: true, name: true, role: true },
  });
  res.json({ success: true, data: user });
});

// GET /api/admin/orders
router.get('/orders', async (_req: Request, res: Response) => {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  res.json({ success: true, data: orders });
});

// PATCH /api/admin/orders/:id/status
router.patch('/orders/:id/status', async (req: Request, res: Response) => {
  const { status } = req.body as { status: string };
  const valid = ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
  if (!valid.includes(status)) {
    res.status(400).json({ success: false, error: 'Invalid status' });
    return;
  }
  const order = await prisma.order.update({
    where: { id: req.params['id'] as string },
    data: { status: status as 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' },
  });
  res.json({ success: true, data: order });
});

export default router;
