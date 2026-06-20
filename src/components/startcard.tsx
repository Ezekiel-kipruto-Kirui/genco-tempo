import { type ReactNode, type ElementType } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";

interface StatsCardProps {
  title: string;
  value: ReactNode;
  icon: ElementType;
  description?: string;
  children?: ReactNode;
}

export const StatsCard = ({ title, value, icon: Icon, description, children }: StatsCardProps) => (
  <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
    <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-600"></div>

    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
      <CardTitle className="text-sm font-medium text-gray-400">{title}</CardTitle>
    </CardHeader>
    <CardContent className="pl-6 pb-4 flex flex-row">
      <div className="mr-2 rounded-full">
        <Icon className="h-8 w-8 text-blue-600" />
      </div>
      <div>
        <div className="text-2xl font-bold text-green-500 mb-2">{value}</div>
        {children}
        {description && (
          <p className="text-xs mt-2 bg-orange-50 px-2 py-1 rounded-md border border-slate-100">
            {description}
          </p>
        )}
      </div>
    </CardContent>
  </Card>
);
