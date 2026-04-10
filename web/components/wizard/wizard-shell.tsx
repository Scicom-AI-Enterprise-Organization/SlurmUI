"use client";

import { useState, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

interface WizardStep {
  title: string;
  description: string;
}

interface WizardShellProps {
  steps: WizardStep[];
  children: ReactNode[];
  onComplete: () => void;
  canProgress?: (step: number) => boolean;
}

export function WizardShell({ steps, children, onComplete, canProgress }: WizardShellProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const isLastStep = currentStep === steps.length - 1;

  const goNext = () => {
    if (isLastStep) {
      onComplete();
    } else {
      setCurrentStep((s) => Math.min(s + 1, steps.length - 1));
    }
  };

  const goBack = () => {
    setCurrentStep((s) => Math.max(s - 1, 0));
  };

  const canGoNext = canProgress ? canProgress(currentStep) : true;

  return (
    <div className="space-y-8">
      {/* Step indicator */}
      <nav className="flex items-center justify-center">
        <ol className="flex items-center gap-2">
          {steps.map((step, index) => (
            <li key={step.title} className="flex items-center">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-medium transition-colors",
                  index < currentStep
                    ? "border-primary bg-primary text-primary-foreground"
                    : index === currentStep
                    ? "border-primary text-primary"
                    : "border-muted text-muted-foreground"
                )}
              >
                {index < currentStep ? (
                  <Check className="h-4 w-4" />
                ) : (
                  index + 1
                )}
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    "mx-2 h-0.5 w-12",
                    index < currentStep ? "bg-primary" : "bg-muted"
                  )}
                />
              )}
            </li>
          ))}
        </ol>
      </nav>

      {/* Step header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold">{steps[currentStep].title}</h2>
        <p className="text-sm text-muted-foreground">
          {steps[currentStep].description}
        </p>
      </div>

      {/* Step content */}
      <div className="mx-auto max-w-2xl">{children[currentStep]}</div>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={goBack}
          disabled={currentStep === 0}
        >
          <ChevronLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={goNext} disabled={!canGoNext}>
          {isLastStep ? "Finish" : "Next"}
          {!isLastStep && <ChevronRight className="ml-2 h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
