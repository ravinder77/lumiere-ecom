import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authenticate, optionalAuth, AuthRequest } from '../middleware/auth';
import { products } from '../data/products';

const router = Router();

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title:  z.string().min(3).max(120).trim(),
  body:   z.string().min(10).max(2000).trim(),
});

// GET /api/reviews/:productId — list reviews for a product (public)
router.get('/:productId', optionalAuth, async (req: Request, res: Response) => {
  const productId = req.params['productId'] as string;

  if (!products.find((p) => p.id === productId)) {
    res.status(404).json({ success: false, error: 'Product not found' });
    return;
  }

  const reviews = await prisma.productReview.findMany({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { id: true, name: true } } },
  });

  const avg = reviews.length
    ? reviews.reduce((s: number, r: { rating: number }) => s + r.rating, 0) / reviews.length
    : 0;

  res.json({
    success: true,
    data: {
      reviews,
      stats: {
        count: reviews.length,
        average: Math.round(avg * 10) / 10,
        distribution: [5, 4, 3, 2, 1].map((star) => ({
          star,
          count: reviews.filter((r: { rating: number }) => r.rating === star).length,
        })),
      },
    },
  });
});

// POST /api/reviews/:productId — submit a review (auth required)
router.post('/:productId', authenticate, async (req: AuthRequest, res: Response) => {
  const productId = req.params['productId'] as string;

  if (!products.find((p) => p.id === productId)) {
    res.status(404).json({ success: false, error: 'Product not found' });
    return;
  }

  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      success: false,
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  // Check if user has ordered this product (mark as verified)
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.userId, status: { in: ['DELIVERED', 'SHIPPED'] } },
  });
  const verified = orders.some((o: { items: unknown }) => {
    const items = (o.items as Array<{ productId: string }>);
    return items.some((i: { productId: string }) => i.productId === productId);
  });

  const review = await prisma.productReview.upsert({
    where: { userId_productId: { userId: req.user!.userId, productId } },
    update: { ...parsed.data, verified },
    create: { userId: req.user!.userId, productId, ...parsed.data, verified },
    include: { user: { select: { id: true, name: true } } },
  });

  res.status(201).json({ success: true, data: review, message: 'Review submitted' });
});

// PATCH /api/reviews/:productId — edit own review
router.patch('/:productId', authenticate, async (req: AuthRequest, res: Response) => {
  const productId = req.params['productId'] as string;
  const parsed = reviewSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const review = await prisma.productReview.update({
      where: { userId_productId: { userId: req.user!.userId, productId } },
      data: parsed.data,
      include: { user: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: review });
  } catch {
    res.status(404).json({ success: false, error: 'Review not found' });
  }
});

// DELETE /api/reviews/:productId — delete own review (or admin)
router.delete('/:productId', authenticate, async (req: AuthRequest, res: Response) => {
  const productId = req.params['productId'] as string;
  const where = req.user!.role === 'ADMIN'
    ? { userId_productId: { userId: req.body.userId ?? req.user!.userId, productId } }
    : { userId_productId: { userId: req.user!.userId, productId } };

  try {
    await prisma.productReview.delete({ where });
    res.json({ success: true, message: 'Review deleted' });
  } catch {
    res.status(404).json({ success: false, error: 'Review not found' });
  }
});

export default router;
