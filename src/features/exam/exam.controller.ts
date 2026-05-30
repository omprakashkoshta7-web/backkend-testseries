import { Response } from 'express';
import { asyncHandler } from '@/middleware/asyncHandler';
import { AuthRequest } from '@/middleware/auth';
import { ExamCategory } from '@/models/ExamCategory';
import { Exam } from '@/models/Exam';
import { ExamSection } from '@/models/ExamSection';
import { Test } from '@/models/Test';
import { Question } from '@/models/Question';
import { TestResult } from '@/models/TestResult';
import { Payment } from '@/models/Payment';
import { SubscriptionPlan } from '@/models/SubscriptionPlan';
import { isUserPremium, getActiveSubscription } from '@/services';
import { normalizeSubscriptionPlans } from '@/utils/subscriptionPlans';
import { getAvailableTestQuery } from '@/utils/testAvailability';

export const getCategories = asyncHandler(async (req: AuthRequest, res: Response) => {
  const categories = await ExamCategory.find({ isActive: true }).sort({ order: 1 });
  res.json({ success: true, data: categories });
});

export const getExamsByCategory = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { categorySlug } = req.params;
  const category = await ExamCategory.findOne({ slug: categorySlug, isActive: true });
  if (!category) {
    return res.status(404).json({ success: false, message: 'Category not found' });
  }
  const exams = await Exam.find({ categoryId: category._id, isActive: true }).populate('sectionId', 'title subtitle icon order').sort({ order: 1 });
  const sections = await ExamSection.find({ categoryId: category._id }).sort({ order: 1 });
  res.json({ success: true, data: { category, exams, sections } });
});

export const getExamDetail = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { examSlug } = req.params;
  const exam = await Exam.findOne({ slug: examSlug, isActive: true }).populate('categoryId', 'name slug');
  if (!exam) {
    return res.status(404).json({ success: false, message: 'Exam not found' });
  }
  const classFilter = req.query.class;
  const subCategoryFilter = req.query.subCategory;

  // Debug: find all tests for this exam name (before availability filter)
  const allTestsForExam = await Test.find({ category: exam.name })
    .select('name category subCategory isActive isPremium testType activeFrom activeUntil')
    .lean();

  const baseQuery: any = { category: exam.name };
  if (classFilter === '11' || classFilter === '12') {
    baseQuery.$or = [{ class: classFilter }, { class: 'all' }];
  }
  if (subCategoryFilter) {
    baseQuery.$or = [
      { subCategory: subCategoryFilter },
      { subCategory: { $exists: false } },
      { subCategory: null },
      { subCategory: '' },
    ];
  }
  const availableQuery = getAvailableTestQuery(baseQuery);
  const testCount = await Test.countDocuments(availableQuery);
  const freeTestCount = await Test.countDocuments(getAvailableTestQuery({ ...baseQuery, isPremium: false }));
  const premiumTestCount = testCount - freeTestCount;
  const tests = await Test.find(availableQuery)
    .select('name description difficulty duration totalQuestions isPremium price originalPrice subject subCategory testType class chapter tags activeFrom activeUntil')
    .sort({ isPremium: 1, createdAt: -1 })
    .limit(200000);
  const testsWithQuestionCount = await Promise.all(
    tests.map(async (test) => {
      const questionCount = await Question.countDocuments({ testId: test._id, isActive: true });
      return { ...test.toObject(), questionCount };
    })
  );
  res.json({ success: true, data: { ...exam.toObject(), testCount, freeTestCount, premiumTestCount, tests: testsWithQuestionCount, _debug: { examName: exam.name, subCategory: subCategoryFilter, allTestsForExam, query: baseQuery } } });
});

export const getHomeData = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  const userId = req.user._id;

  const [categories, recentResults, payment, tests, freeTests, plans] = await Promise.all([
    ExamCategory.find({ isActive: true }).sort({ order: 1 }).limit(8),
    TestResult.find({ userId }).sort({ completedAt: -1 }).limit(5).populate('testId', 'name category'),
    getActiveSubscription(userId),
    Test.find(getAvailableTestQuery({ isPremium: true })).sort({ createdAt: -1 }).limit(6),
    Test.find(getAvailableTestQuery({ isPremium: false })).sort({ createdAt: -1 }).limit(6),
    SubscriptionPlan.find({ isActive: true }).sort({ order: 1 }),
  ]);

  const isPremium = !!payment;
  const recentForContinue = await TestResult.find({ userId })
    .sort({ completedAt: -1 })
    .limit(3)
    .populate('testId', 'name category duration totalQuestions difficulty');

  const continueTestsList = recentForContinue.map(r => ({
    testId: ((r.testId as any)?._id)?.toString(),
    testName: (r.testId as any)?.name || 'Unknown',
    category: (r.testId as any)?.category || '',
    duration: (r.testId as any)?.duration || 0,
    totalQuestions: (r.testId as any)?.totalQuestions || 0,
    progress: Math.min(100, Math.round(((r.score || 0) / (r.totalMarks || 1)) * 100)),
  }));

  res.json({
    success: true,
    data: {
      user: { name: req.user.name, streak: req.user.streak || 0, points: req.user.totalPoints || 0 },
      categories,
      recentActivity: recentResults.map(r => ({
        testId: ((r.testId as any)?._id)?.toString(),
        testName: (r.testId as any)?.name || 'Unknown',
        score: r.score,
        totalMarks: r.totalMarks,
        accuracy: r.accuracy,
        completedAt: r.completedAt,
      })),
      continueTests: continueTestsList,
      recommendedExams: isPremium ? tests : tests.filter(t => !t.isPremium),
      freeTests,
      plans: normalizeSubscriptionPlans(plans),
      isPremium,
      subscription: payment ? {
        plan: payment.plan,
        endDate: payment.endDate,
        autoRenew: payment.autoRenew,
      } : null,
    },
  });
});

export const checkAccess = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  const { testId } = req.params;

  const test = await Test.findById(testId);
  if (!test) {
    return res.status(404).json({ success: false, message: 'Test not found' });
  }

  if (!test.isPremium) {
    return res.json({ success: true, data: { hasAccess: true, isPremium: false, message: 'Free test' } });
  }

  const payment = await getActiveSubscription(req.user._id);

  if (payment) {
    return res.json({ success: true, data: { hasAccess: true, isPremium: true, plan: payment.plan, endDate: payment.endDate } });
  }

  return res.json({
    success: true,
    data: { hasAccess: false, isPremium: true, message: 'Premium test. Please purchase a plan.' },
  });
});

export const getUserDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  const userId = req.user._id;

  const payment = await getActiveSubscription(userId);

  const isPremium = !!payment;
  const planName = payment?.plan || 'free';
  const planEndDate = payment?.endDate || null;

  const totalTestsTaken = await TestResult.countDocuments({ userId });
  const recentResults = await TestResult.find({ userId })
    .sort({ completedAt: -1 }).limit(5).populate('testId', 'name difficulty totalQuestions');

  const continueTest = await TestResult.findOne({ userId, status: 'in_progress' })
    .populate('testId', 'name duration totalQuestions difficulty');

  const availableTests = isPremium
    ? await Test.find({ isActive: true }).sort({ createdAt: -1 }).limit(12)
    : await Test.find({ isActive: true, isPremium: false }).sort({ createdAt: -1 }).limit(12);

  const allResults = await TestResult.find({ userId }).sort({ score: -1 });
  const avgAccuracy = allResults.length > 0
    ? Math.round(allResults.reduce((a, r) => a + r.accuracy, 0) / allResults.length)
    : 0;
  const bestScore = allResults.length > 0 ? Math.max(...allResults.map(r => r.score)) : 0;

  const topicResults = await TestResult.aggregate([
    { $match: { userId: userId } },
    { $group: { _id: '$testId', avgScore: { $avg: '$score' }, count: { $sum: 1 } } },
    { $limit: 10 },
  ]);

  res.json({
    success: true,
    data: {
      isPremium,
      planName,
      planEndDate,
      totalTestsTaken,
      avgAccuracy,
      bestScore,
      recentResults: recentResults.map(r => ({
        testId: (r.testId as any)?._id,
        testName: (r.testId as any)?.name || 'Unknown',
        difficulty: (r.testId as any)?.difficulty || 'medium',
        score: r.score,
        totalMarks: r.totalMarks,
        accuracy: r.accuracy,
        completedAt: r.completedAt,
      })),
      continueTest: continueTest ? {
        testId: (continueTest.testId as any)?._id,
        testName: (continueTest.testId as any)?.name || 'Unknown',
        duration: (continueTest.testId as any)?.duration || 0,
        totalQuestions: (continueTest.testId as any)?.totalQuestions || 0,
      } : null,
      availableTests: availableTests.map(t => ({
        _id: t._id,
        name: t.name,
        category: t.category,
        difficulty: t.difficulty,
        duration: t.duration,
        totalQuestions: t.totalQuestions,
        isPremium: t.isPremium,
      })),
      topicPerformance: topicResults,
    },
  });
});
