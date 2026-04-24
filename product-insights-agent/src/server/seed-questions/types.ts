export interface SeedQuestion {
  id: string;
  text: string;
  productId: string;
  createdAt: Date;
}

export interface SeedQuestionCache {
  productId: string;
  questions: SeedQuestion[];
  createdAt: Date;
}
