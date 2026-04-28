import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  updateProfileSchema,
} from '../validators/auth';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeUser(user: { id: string; email: string; name: string; role: string; createdAt: Date }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt };
}

function makeTokens(user: { id: string; email: string; role: string }) {
  const payload = { userId: user.id, email: user.email, role: user.role };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      success: false,
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ success: false, error: 'An account with this email already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, passwordHash },
  });

  const tokens = makeTokens(user);

  res.status(201).json({
    success: true,
    message: 'Account created successfully',
    data: { user: safeUser(user), ...tokens },
  });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      success: false,
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Timing-safe — always hash even on miss
    await bcrypt.compare(password, '$2b$12$invalid.hash.padding.to.prevent.timing.attacks');
    res.status(401).json({ success: false, error: 'Invalid email or password' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ success: false, error: 'Invalid email or password' });
    return;
  }

  const tokens = makeTokens(user);

  res.json({
    success: true,
    message: 'Logged in successfully',
    data: { user: safeUser(user), ...tokens },
  });
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req: Request, res: Response) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: 'Refresh token required' });
    return;
  }

  try {
    const payload = verifyRefreshToken(parsed.data.refreshToken);
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }

    const tokens = makeTokens(user);
    res.json({ success: true, data: tokens });
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  res.json({ success: true, data: { user } });
});

// ── PATCH /api/auth/profile ───────────────────────────────────────────────────
router.patch('/profile', authenticate, async (req: AuthRequest, res: Response) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      success: false,
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { name, email } = parsed.data;

  if (email) {
    const conflict = await prisma.user.findFirst({
      where: { email, NOT: { id: req.user!.userId } },
    });
    if (conflict) {
      res.status(409).json({ success: false, error: 'Email already in use' });
      return;
    }
  }

  const updated = await prisma.user.update({
    where: { id: req.user!.userId },
    data: { ...(name && { name }), ...(email && { email }) },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  res.json({ success: true, message: 'Profile updated', data: { user: updated } });
});

// ── POST /api/auth/change-password ───────────────────────────────────────────
router.post('/change-password', authenticate, async (req: AuthRequest, res: Response) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      success: false,
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ success: false, error: 'Current password is incorrect' });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  res.json({ success: true, message: 'Password changed successfully' });
});

// ── GET /api/auth/orders ──────────────────────────────────────────────────────
router.get('/orders', authenticate, async (req: AuthRequest, res: Response) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: orders });
});

export default router;
