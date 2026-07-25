import { ToolDecorator as Tool, z, ExecutionContext, Injectable, UseInterceptors } from '@nitrostack/core';
import { UserRepository } from '../../data/repositories/user-repository.js';
import { LabRepository } from '../../data/repositories/lab-repository.js';
import { HistoryRepository } from '../../data/repositories/history-repository.js';
import { DishRepository } from '../../data/repositories/dish-repository.js';

import { BudgetRepository } from '../../data/repositories/budget-repository.js';
import { clinicalTools } from '../clinical/clinical.tools.js';
import { applyFilters } from '../catalog/catalog.tools.js';
import { evaluateDishSafety } from '../../domain/safety-evaluator.js';

import { ClinicalScorerService, CLINICAL_SCORER_CONFIG } from './scoring/clinical-scorer.service.js';
import { ContextualScorerService, CONTEXTUAL_SCORER_CONFIG } from './scoring/contextual-scorer.service.js';
import { BudgetScorerService, BUDGET_SCORER_CONFIG } from './scoring/budget-scorer.service.js';
import { CravingScorerService, CRAVING_SCORER_CONFIG } from './scoring/craving-scorer.service.js';
import { SafetyInterceptor } from '../../interceptors/safety.interceptor.js';
import { Dish } from '../../domain/types.js';

const ResolveRecommendationInputSchema = z.object({
  userId: z.string().describe('User ID.'),
  meal_slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).describe('The meal slot.'),
  craving: z.string().optional().describe('Optional craving (dish_id, cuisine, or free-text).'),
  candidate_dish_ids: z.array(z.string()).optional().describe('Optional array of dish IDs to evaluate.'),
  context: z.any().optional().describe('Optional context object (e.g. weather).'),
  budget_override: z.object({ reason: z.string() }).optional().describe('Optional budget override reason.'),
  max_results: z.number().default(3).describe('Max results to return.'),
});

type ResolveRecommendationInput = z.infer<typeof ResolveRecommendationInputSchema>;

interface ScoredCandidate {
  dish: Dish;
  clinicalScore: number;
  contextualScore: number;
  budgetScore: number;
  cravingScore: number;
  warns: any[];
  allBreakdowns: any;
}

@Injectable()
export class resolverTools {
  private userRepo: UserRepository;
  private labRepo: LabRepository;
  private historyRepo: HistoryRepository;
  private dishRepo: DishRepository;
  private budgetRepo: BudgetRepository;

  private clinicalToolsModule = new clinicalTools();
  private clinicalScorer = new ClinicalScorerService();
  private contextualScorer = new ContextualScorerService();
  private budgetScorer = new BudgetScorerService();
  private cravingScorer = new CravingScorerService();

  constructor(
    userRepo?: UserRepository,
    labRepo?: LabRepository,
    historyRepo?: HistoryRepository,
    dishRepo?: DishRepository,
    budgetRepo?: BudgetRepository
  ) {
    this.userRepo = userRepo || new UserRepository();
    this.labRepo = labRepo || new LabRepository();
    this.historyRepo = historyRepo || new HistoryRepository();
    this.dishRepo = dishRepo || new DishRepository();
    this.budgetRepo = budgetRepo || new BudgetRepository();
  }

  @Tool({
    name: 'resolve_recommendation',
    description: 'Call compute_nutritional_envelope first! ' +
      'This tool returns a decision AND its justification. Present the conflict_log to the user rather than only the winner, because the trade-off reasoning is the product.',
    inputSchema: ResolveRecommendationInputSchema,
  })
  @UseInterceptors(SafetyInterceptor)
  async resolveRecommendation(input: ResolveRecommendationInput, context: ExecutionContext) {
    const profile = this.userRepo.getById(input.userId);
    if (!profile) throw new Error(`User not found: ${input.userId}`);
    const labReports = this.labRepo.getByUserId(input.userId);
    const latestLabs = labReports.length > 0 ? labReports.sort((a, b) => new Date(b.report_date).getTime() - new Date(a.report_date).getTime())[0] : undefined;
    const history = this.historyRepo.getByUserId(input.userId);

    // Get envelope
    const envelope = await this.clinicalToolsModule.computeNutritionalEnvelope({ userId: input.userId, meal_slot: input.meal_slot }, context);

    const calculation_trace: any = {
      envelope_used: envelope,
      stages: {},
      scoring_config_versions: {
        clinical: CLINICAL_SCORER_CONFIG.version,
        contextual: CONTEXTUAL_SCORER_CONFIG.version,
        budget: BUDGET_SCORER_CONFIG.version,
        craving: CRAVING_SCORER_CONFIG.version,
      },
      pareto_front: []
    };

    // Stage 1 - CANDIDATE ASSEMBLY
    let candidates: Dish[] = [];
    if (input.candidate_dish_ids && input.candidate_dish_ids.length > 0) {
      candidates = input.candidate_dish_ids.map(id => this.dishRepo.getAll().find(d => d.id === id)).filter(Boolean) as Dish[];
      calculation_trace.stages.assembly = { method: 'explicit_ids', count: candidates.length };
    } else {
      // Derive filters from hard constraints
      const filters: any = {};
      const sodiumConstraint = envelope.hard_constraints.find(c => c.nutrient === 'sodium_mg');
      if (sodiumConstraint) filters.max_sodium_mg = sodiumConstraint.threshold;
      
      const sugarConstraint = envelope.hard_constraints.find(c => c.nutrient === 'sugar_g');
      if (sugarConstraint) filters.max_sugar_g = sugarConstraint.threshold;
      
      const allDishes = this.dishRepo.getAll();
      candidates = allDishes.filter(d => applyFilters(d, filters)).slice(0, 60);
      calculation_trace.stages.assembly = { method: 'catalog_search_with_envelope_filters', count: candidates.length };
    }

    // Stage 2 - SAFETY FILTER
    const safeCandidates: Dish[] = [];
    const droppedForSafety: any[] = [];
    const safeCandidatesWarns = new Map<string, any[]>();

    for (const dish of candidates) {
      const verdicts = evaluateDishSafety(dish, profile, latestLabs);
      const blocks = verdicts.filter(v => v.status === 'BLOCK');
      if (blocks.length > 0) {
        droppedForSafety.push({
          dish_id: dish.id,
          dish_name: dish.name,
          killed_by_rules: blocks.map(b => b.rule_id)
        });
      } else {
        safeCandidates.push(dish);
        safeCandidatesWarns.set(dish.id, verdicts.filter(v => v.status === 'WARN'));
      }
    }
    calculation_trace.stages.safety_filter = { surviving_count: safeCandidates.length, dropped_count: droppedForSafety.length };

    if (safeCandidates.length === 0) {
      return {
        results: [],
        no_safe_option: {
          message: 'No safe candidates found.',
          binding_constraints: droppedForSafety.flatMap(d => d.killed_by_rules),
          suggestion: 'Relax explicit candidate list or loosen soft constraints if any.'
        },
        dropped_for_safety: droppedForSafety,
        calculation_trace
      };
    }

    // Stage 3 - SCORE
    const budgetState = this.budgetRepo.getBudgetState(input.userId);
    
    const historyOrders = history.orders.map(o => ({
      user_id: o.user_id,
      timestamp: o.timestamp,
      dish_id: o.dish_id,
      portion_multiplier: 1
    }));
    
    const scoredCandidates: ScoredCandidate[] = safeCandidates.map(dish => {
      const warns = safeCandidatesWarns.get(dish.id) || [];
      const clin = this.clinicalScorer.scoreClinicalFit(dish, envelope, warns);
      const ctx = this.contextualScorer.scoreContextualFit(dish, profile, historyOrders, input.context);
      const budg = this.budgetScorer.scoreBudgetFit(dish, budgetState, profile);
      const crav = this.cravingScorer.scoreCravingSatisfaction(dish, input.craving, historyOrders);

      return {
        dish,
        clinicalScore: clin.score,
        contextualScore: ctx.score,
        budgetScore: budg.score,
        cravingScore: crav.score,
        warns,
        allBreakdowns: { clinical: clin, contextual: ctx, budget: budg, craving: crav }
      };
    });

    // Stage 4 - PARETO FRONT
    const EPSILON = 0.02;
    const paretoFront: ScoredCandidate[] = [];
    let dominatedCount = 0;

    for (const a of scoredCandidates) {
      let isDominated = false;
      for (const b of scoredCandidates) {
        if (a === b) continue;
        
        const bDominatesA = 
          b.clinicalScore >= a.clinicalScore - EPSILON &&
          b.contextualScore >= a.contextualScore - EPSILON &&
          b.budgetScore >= a.budgetScore - EPSILON &&
          b.cravingScore >= a.cravingScore - EPSILON &&
          (
            b.clinicalScore > a.clinicalScore + EPSILON ||
            b.contextualScore > a.contextualScore + EPSILON ||
            b.budgetScore > a.budgetScore + EPSILON ||
            b.cravingScore > a.cravingScore + EPSILON
          );

        if (bDominatesA) {
          isDominated = true;
          break;
        }
      }

      if (!isDominated) {
        paretoFront.push(a);
      } else {
        dominatedCount++;
      }
    }
    
    calculation_trace.stages.pareto_front = { front_size: paretoFront.length, dominated_count: dominatedCount };
    calculation_trace.pareto_front = paretoFront.map(c => ({ dish_id: c.dish.id, scores: c.allBreakdowns }));

    // Stage 5 - LEXICOGRAPHIC TIEBREAK
    const sortedFront = [...paretoFront].sort((a, b) => {
      // 1. Fewest/least severe WARNs
      const aWarnWeight = a.warns.reduce((sum, w) => sum + (w.severity === 'severe' ? 2 : 1), 0);
      const bWarnWeight = b.warns.reduce((sum, w) => sum + (w.severity === 'severe' ? 2 : 1), 0);
      if (aWarnWeight !== bWarnWeight) return aWarnWeight - bWarnWeight; // ASC

      // 2. Hard budget cap (unless overridden)
      if (!input.budget_override) {
        const aOverBudget = a.dish.price_inr > budgetState.budget_inr_remaining;
        const bOverBudget = b.dish.price_inr > budgetState.budget_inr_remaining;
        if (aOverBudget !== bOverBudget) return aOverBudget ? 1 : -1; // ASC (false beats true)
      }

      // 3. Craving satisfaction
      if (Math.abs(a.cravingScore - b.cravingScore) > EPSILON) return b.cravingScore - a.cravingScore; // DESC

      // 4. Contextual score
      if (Math.abs(a.contextualScore - b.contextualScore) > EPSILON) return b.contextualScore - a.contextualScore; // DESC

      // 5. Lowest dish_id
      return a.dish.id.localeCompare(b.dish.id);
    });

    const winner = sortedFront[0];
    const topRunnersUp = sortedFront.slice(1, Math.min(sortedFront.length, 1 + input.max_results));
    
    calculation_trace.stages.tiebreak = { winner_dish_id: winner.dish.id };

    // Stage 6 - CONFLICT LOG
    const clinicallyOptimal = [...scoredCandidates].sort((a, b) => b.clinicalScore - a.clinicalScore)[0];
    const cheapestSafe = [...scoredCandidates].sort((a, b) => a.dish.price_inr - b.dish.price_inr)[0];
    const highestCraving = [...scoredCandidates].sort((a, b) => b.cravingScore - a.cravingScore)[0];

    const generateTradeoff = (candidate: ScoredCandidate) => {
      const sacrifices = [];
      if (candidate.clinicalScore < clinicallyOptimal.clinicalScore - EPSILON) {
        sacrifices.push(`Lower clinical score than optimal (lost ${Math.round((clinicallyOptimal.clinicalScore - candidate.clinicalScore)*100)}% alignment)`);
      }
      if (candidate.dish.price_inr > cheapestSafe.dish.price_inr) {
        sacrifices.push(`₹${candidate.dish.price_inr - cheapestSafe.dish.price_inr} more expensive than cheapest safe option`);
      }
      if (candidate.dish.price_inr > budgetState.budget_inr_remaining) {
        sacrifices.push(`₹${candidate.dish.price_inr - budgetState.budget_inr_remaining} over remaining budget`);
      }
      return sacrifices;
    };

    const conflict_log = {
      winner: {
        dish_id: winner.dish.id,
        dish_name: winner.dish.name,
        sacrifices: generateTradeoff(winner),
        carried_warns: winner.warns.map(w => ({ text: w.rule_text, citation: w.source_citation }))
      },
      runners_up: topRunnersUp.map(ru => ({
        dish_id: ru.dish.id,
        dish_name: ru.dish.name,
        lost_because: `Tiebreak ranked ${winner.dish.name} higher.`,
        sacrifices: generateTradeoff(ru)
      })),
      alternatives_context: {
        clinically_optimal: clinicallyOptimal.dish.id !== winner.dish.id ? {
          dish_id: clinicallyOptimal.dish.id,
          disqualified_reason: `Lost in tiebreak (likely due to budget, craving, or warnings).`
        } : null,
        cheapest_safe: cheapestSafe.dish.id !== winner.dish.id ? {
          dish_id: cheapestSafe.dish.id,
          disqualified_reason: `Lost in tiebreak (likely due to clinical or craving score).`
        } : null,
        highest_craving: highestCraving.dish.id !== winner.dish.id ? {
          dish_id: highestCraving.dish.id,
          disqualified_reason: `Lost in tiebreak (likely due to warnings or budget).`
        } : null,
      }
    };

    return {
      recommendations: sortedFront.slice(0, input.max_results).map(c => c.dish),
      conflict_log,
      dropped_for_safety: droppedForSafety,
      pareto_summary: { front_size: paretoFront.length, dominated: dominatedCount },
      calculation_trace
    };
  }
}
